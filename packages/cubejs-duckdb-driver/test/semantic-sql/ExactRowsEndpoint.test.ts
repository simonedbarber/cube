import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

// Residual native SUM boundaries. Literal inputs deliberately issue no Cube
// source request: this qualifies parser/window/type/HTTP behavior, not MEASURE
// ownership, application grants or a published runtime image.
const packet = JSON.parse(readFileSync(join(__dirname, '../../../test/semantic-sql/CombinedRowsEndpoint.fixture.json'), 'utf8')) as { model: string };
const ownedPort = process.env.CUBE_COMBINED_ROWS_TEST_POSTGRES_PORT;
const describeOwned = ownedPort ? describe : describe.skip;
const maximumDecimal = `${'9'.repeat(32)}.999999`;
const minimumDecimal = `-${maximumDecimal}`;

function sql(values: (string | null)[], type: string, preceding: number) {
  const input = values.map((value, index) => `SELECT ${index + 1} AS slot, CAST(${value === null ? 'NULL' : `'${value}'`} AS ${type}) AS amount`).join(' UNION ALL ');
  return `WITH input AS (${input}) SELECT slot, SUM(amount) OVER (ORDER BY slot ROWS BETWEEN ${preceding} PRECEDING AND CURRENT ROW) AS total FROM input ORDER BY slot LIMIT 20`;
}

const valid = [
  { id: 'DECIMAL-WIDE-PARTIALS',
    type: 'DECIMAL(38,6)',
    columnType: 'Decimal(38, 6)',
    preceding: 2,
    values: [minimumDecimal, maximumDecimal, maximumDecimal, minimumDecimal, minimumDecimal, maximumDecimal],
    totals: [minimumDecimal, '0.000000', maximumDecimal, maximumDecimal, minimumDecimal, minimumDecimal] },
  { id: 'INT64-WIDE-PARTIALS',
    type: 'BIGINT',
    columnType: 'Int64',
    preceding: 2,
    values: ['-9223372036854775807', '9223372036854775807', '9223372036854775807', '-9223372036854775807', '-9223372036854775807', '9223372036854775807'],
    totals: ['-9223372036854775807', '0', '9223372036854775807', '9223372036854775807', '-9223372036854775807', '-9223372036854775807'] },
  { id: 'DECIMAL-FRACTION-NULL',
    type: 'DECIMAL(38,6)',
    columnType: 'Decimal(38, 6)',
    preceding: 1,
    values: [null, '123.450001', '-0.000001', null, null],
    totals: [null, '123.450001', '123.450000', '-0.000001', null] },
  { id: 'DECIMAL-CURRENT-MAX',
    type: 'DECIMAL(38,6)',
    columnType: 'Decimal(38, 6)',
    preceding: 0,
    values: [maximumDecimal, maximumDecimal, null, minimumDecimal],
    totals: [maximumDecimal, maximumDecimal, null, minimumDecimal] },
];
const overflow = [
  { id: 'DECIMAL-POSITIVE-OVERFLOW', type: 'DECIMAL(38,6)', values: [maximumDecimal, '0.000001'] },
  { id: 'DECIMAL-NEGATIVE-OVERFLOW', type: 'DECIMAL(38,6)', values: [minimumDecimal, '-0.000001'] },
  { id: 'INT64-POSITIVE-OVERFLOW', type: 'BIGINT', values: ['9223372036854775807', '1'] },
  { id: 'INT64-NEGATIVE-OVERFLOW', type: 'BIGINT', values: ['-9223372036854775808', '-1'] },
];

describeOwned('Exact finite ROWS sums through native HTTP', () => {
  jest.setTimeout(60000);
  let oracle: Client;
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  beforeAll(async () => {
    oracle = new Client({ host: '127.0.0.1', port: Number(ownedPort), user: 'postgres', password: 'owned-combined-rows-fixture', database: 'postgres' });
    await oracle.connect();
    endpoint = await startSemanticSqlEndpoint({ model: () => packet.model,
      setupSQL: '',
      streamMode: true,
      grants: new Map([['analyst', ['semantic_analyst']]]) });
  });
  afterAll(async () => { try { await endpoint?.stop(); } finally { await oracle?.end(); } });

  test.each(valid)('$id preserves exact totals, type and NULL over first/repeat', async fixture => {
    const query = sql(fixture.values, fixture.type, fixture.preceding);
    const expected = fixture.totals.map((total, index) => [String(index + 1), total]);
    const observed = await oracle.query(query);
    expect(observed.rows.map(row => [String(row.slot), row.total])).toEqual(expected);
    const captures = [];

    for (const temperature of ['FIRST', 'REPEAT']) {
      const cursor = endpoint.sourceRequests.length;
      const actual = await endpoint.execute(query, 'analyst');
      const schema = actual.messages.find(message => message.schema)?.schema;
      console.log('exact ROWS native observation', JSON.stringify({ caseId: fixture.id, temperature, query, rows: actual.rows, schema, oracle: expected, sourceRequests: endpoint.sourceRequests.slice(cursor) }));
      expect(actual.rows).toEqual(expected);
      expect(schema).toEqual([{ name: 'slot', column_type: 'Int64' }, { name: 'total', column_type: fixture.columnType }]);
      expect(endpoint.sourceRequests.slice(cursor)).toHaveLength(0);
      captures.push({ temperature, rows: actual.rows, schema, sourceRequests: [] });
    }
    console.log('exact ROWS native capture', JSON.stringify({ caseId: fixture.id, query, oracle: expected, captures }));
  });

  test.each(overflow)('$id rejects an unrepresentable result and leaves the endpoint usable', async fixture => {
    const query = sql(fixture.values, fixture.type, 1);
    // PostgreSQL's wider SUM result proves the mathematical answer. The native
    // declared Int64/Decimal(38,6) contract must reject it, rather than narrow it.
    const mathematical = await oracle.query(query);
    const captures = [];

    for (const temperature of ['FIRST', 'REPEAT']) {
      let failure: Error | undefined;

      try {
        const actual = await endpoint.execute(query, 'analyst');
        console.log('exact ROWS overflow accepted', JSON.stringify({ caseId: fixture.id, temperature, query, rows: actual.rows, schema: actual.messages.find(message => message.schema)?.schema, oracle: mathematical.rows }));
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        failure = error;
      }
      expect(failure).toBeDefined();
      expect(failure!.message).toMatch(/ROWS SUM result exceeds/i);
      expect((await endpoint.execute('SELECT 1 AS alive LIMIT 1', 'analyst')).rows).toEqual([['1']]);
      captures.push({ temperature, error: failure!.message });
    }
    expect(endpoint.sourceRequests).toHaveLength(0);
    console.log('exact ROWS native rejection', JSON.stringify({ caseId: fixture.id, query, oracle: mathematical.rows, captures }));
  });
});

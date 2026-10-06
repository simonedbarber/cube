import canonicalPacket from './fixtures/modeled-local-parity-canonical-sql.json';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

type Fixture = {
  id: string;
  owner: 'modeled' | 'local';
  cube: string;
  kind: 'ratio' | 'share' | 'calendar';
  key?: string;
  query: string;
  sourceOracle: string;
  expected: Array<[string | null, number | null]>;
};
function keyValue(fixture: Fixture, value: unknown) {
  if (!fixture.key) return null;
  if (fixture.kind === 'calendar') return String(value).slice(0, 7);
  return value;
}
const packet = { ...canonicalPacket,
  cases: canonicalPacket.cases.map((fixture): Fixture => {
    if (fixture.owner !== 'modeled' && fixture.owner !== 'local') throw new Error(`Invalid owner: ${fixture.owner}`);
    if (fixture.kind !== 'ratio' && fixture.kind !== 'share' && fixture.kind !== 'calendar') throw new Error(`Invalid kind: ${fixture.kind}`);
    const expected = fixture.expected.map((row): [string | null, number | null] => {
      const [key, value] = row;
      if (row.length !== 2 || (key !== null && typeof key !== 'string') || (value !== null && typeof value !== 'number')) {
        throw new Error(`Invalid expected tuple for ${fixture.id}`);
      }
      return [key, value];
    });
    return { ...fixture, owner: fixture.owner, kind: fixture.kind, expected };
  }) };

/** Actual native SQL HTTP, semantic compiler and source driver with the same
 * authored queries as the pinned MC26 packet. This does not establish
 * application authority/cache, immutable release or lifecycle qualification. */
describe('Modeled/local MC26 decimal component parity through SQL HTTP', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  beforeAll(async () => {
    endpoint = await startSemanticSqlEndpoint({ model: () => packet.modelSource,
      setupSQL: packet.setupSQL,
      streamMode: true,
      grants: new Map([['auditor', ['auditor']]]) });
  });
  afterAll(async () => { await endpoint?.stop(); });

  test.each([
    { id: 'MC18-SAFE-DIVISION',
      query: `SELECT
      CAST(CAST(1 AS DECIMAL(38,9))/NULLIF(CAST(2 AS DECIMAL(38,9)),CAST(0 AS DECIMAL(38,9))) AS DECIMAL(38,9)) AS half,
      CAST(CAST(1 AS DECIMAL(38,9))/NULLIF(CAST(0 AS DECIMAL(38,9)),CAST(0 AS DECIMAL(38,9))) AS DECIMAL(38,9)) AS zero_den,
      CAST(CAST(NULL AS DECIMAL(38,9))/NULLIF(CAST(2 AS DECIMAL(38,9)),CAST(0 AS DECIMAL(38,9))) AS DECIMAL(38,9)) AS null_num,
      CAST(CAST(0 AS DECIMAL(38,9))/NULLIF(CAST(2 AS DECIMAL(38,9)),CAST(0 AS DECIMAL(38,9))) AS DECIMAL(38,9)) AS zero_num`,
      names: ['half', 'zero_den', 'null_num', 'zero_num'],
      expected: ['0.500000000', null, null, '0.000000000'] },
    { id: 'MC18-DECIMAL-ARITHMETIC',
      query: `SELECT
      CAST(CAST(0.1 AS DECIMAL(38,9))+CAST(0.2 AS DECIMAL(38,9)) AS DECIMAL(38,9)) AS decimal_sum,
      CAST(CAST(0.3 AS DECIMAL(38,9))/CAST(0.3 AS DECIMAL(38,9)) AS DECIMAL(38,9)) AS decimal_ratio`,
      names: ['decimal_sum', 'decimal_ratio'],
      expected: ['0.300000000', '1.000000000'] },
    { id: 'MC18-DECIMAL-GROWTH',
      query: `SELECT CAST((CAST(300 AS DECIMAL(38,9))-CAST(200 AS DECIMAL(38,9))) AS DECIMAL(38,9))/NULLIF(CAST(200 AS DECIMAL(38,9)),CAST(0 AS DECIMAL(38,9))) AS growth`,
      names: ['growth'],
      expected: ['0.500000000'] },
    { id: 'MC18-EXACT-LARGE-INTEGER',
      query: `SELECT CAST(CAST(9007199254740993 AS DECIMAL(38,9))/CAST(3 AS DECIMAL(38,9)) AS DECIMAL(38,9)) AS exact_quotient`,
      names: ['exact_quotient'],
      expected: ['3002399751580331.000000000'] },
  ])('$id preserves residual decimal values before formatting', async fixture => {
    const cursor = endpoint.sourceRequests.length;
    const result = await endpoint.execute(fixture.query, 'auditor');
    expect(result.messages.find(message => message.schema)?.schema).toEqual(fixture.names.map(name => ({ name, column_type: 'Decimal(38, 9)' })));
    expect(result.rows).toEqual([fixture.expected]);
    expect(endpoint.sourceRequests.length).toBe(cursor);
  });

  test.each(packet.cases)('$id-$owner returns the independently specified result', async fixture => {
    const oracle = await (await endpoint.connection.run(fixture.sourceOracle)).getRowObjects();
    const oracleRows = oracle.map(row => [keyValue(fixture, fixture.kind === 'calendar' ? row.bucket : row.region),
      row.value == null ? null : Number(row.value)]);
    expect(oracleRows).toEqual(fixture.expected);
    const cursor = endpoint.sourceRequests.length;
    const result = await endpoint.execute(fixture.query, 'auditor');
    const member = { ratio: 'ratio', share: 'share', calendar: 'growth' }[fixture.kind];
    const baseName = fixture.kind === 'share' ? 'value' : 'current';
    const baseColumn = fixture.owner === 'local' ? baseName : `${fixture.cube}.${baseName}`;
    const schema = [
      ...(fixture.key ? [{ name: fixture.key, column_type: fixture.kind === 'calendar' ? 'Timestamp' : 'String' }] : []),
      ...(fixture.kind === 'ratio' ? [] : [{ name: baseColumn, column_type: 'Double' }]),
      { name: fixture.owner === 'local' ? 'local_value' : `${fixture.cube}.${member}`, column_type: fixture.owner === 'local' ? 'Decimal(38, 9)' : 'Double' },
    ];
    const actual = result.rows.map(row => {
      const key = keyValue(fixture, row[0]);
      const value = row[row.length - 1];
      if (value !== null) expect(typeof value).toBe('string');
      return [key, value === null ? null : Number(value)];
    });
    expect(actual).toEqual(fixture.expected);
    expect(result.messages.find(message => message.schema)?.schema).toEqual(schema);
    if (fixture.owner === 'local') {
      // Check the exact decimal wire text before numeric comparison/formatting.
      const expected = fixture.expected.map(([, value]) => (value === null ? null : value.toFixed(9)));
      expect(result.rows.map(row => row[row.length - 1])).toEqual(expected);
    }
    const issued = endpoint.sourceRequests.slice(cursor);
    expect(issued.length).toBeGreaterThan(0);
    expect(issued.every(request => request.principal === 'auditor' && request.completed)).toBe(true);
    expect(issued.every(request => request.query.includes("channel = 'keep'"))).toBe(true);
    console.log('canonical MC26 semantic parity capture', JSON.stringify({ caseId: fixture.id,
      owner: fixture.owner,
      actual,
      schema,
      sourceRequests: issued }));
  });
});

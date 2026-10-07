import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { PostgresDriver } from '@cubejs-backend/postgres-driver';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

// Generated from QueryRails' guarded development planner. PostgreSQL recomputes
// observations independently; this source check does not qualify an image,
// application grants, or the full orchestrator cache path. It does exercise
// the actual source queue lifecycle, including cancellation and fresh retries.
const packet = JSON.parse(readFileSync(join(__dirname, '../../../test/semantic-sql/CombinedRowsEndpoint.fixture.json'), 'utf8')) as {
  model: string; setup: string; cases: { id: string; sql: string; analystOracle: string; auditorOracle: string; unpartitionedOracle?: string }[];
};
const ownedPort = process.env.CUBE_COMBINED_ROWS_TEST_POSTGRES_PORT;
const describeOwned = ownedPort ? describe : describe.skip;
const keys = ['analytics_combined_frames.region', 'analytics_combined_frames.slot', 'window', 'position', 'grand', 'share'];
const sorted = (rows: unknown[][]) => [...rows].sort((a, b) => JSON.stringify(a.slice(0, 2)).localeCompare(JSON.stringify(b.slice(0, 2))));
function compare(actual: unknown[][], expected: unknown[][]) {
  expect(actual).toHaveLength(expected.length);
  sorted(expected).forEach((row, index) => {
    const result = sorted(actual)[index];
    expect(result[0]).toEqual(row[0]);

    for (let column = 1; column < keys.length; column++) {
      if (row[column] === null) expect(result[column]).toBeNull();
      else { expect(result[column]).not.toBeNull(); expect(Number(result[column])).toBeCloseTo(Number(row[column]), 9); }
    }
  });
}

describeOwned('Combined native ROWS frames on PostgreSQL source', () => {
  jest.setTimeout(60000);
  let source: Client;
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  const grants = new Map([['analyst', ['semantic_analyst']], ['auditor', ['semantic_auditor']]]);
  beforeAll(async () => {
    source = new Client({ host: '127.0.0.1', port: Number(ownedPort), user: 'postgres', password: 'owned-combined-rows-fixture', database: 'postgres' });
    await source.connect();
    await source.query(packet.setup);
    endpoint = await startSemanticSqlEndpoint({ model: () => packet.model,
      setupSQL: '',
      grants,
      streamMode: true,
      sourceDialect: 'postgres',
      queueSourceStreams: true,
      sourceDriver: new PostgresDriver({ host: '127.0.0.1', port: Number(ownedPort), user: 'postgres', password: 'owned-combined-rows-fixture', database: 'postgres', maxPoolSize: 2, readOnly: true }) });
  });
  afterAll(async () => { try { await endpoint?.stop(); } finally { await source?.end(); } });
  const cases = (['analyst', 'auditor'] as const).flatMap(principal => packet.cases.map(fixture => ({ ...fixture, principal })));
  test.each(cases)('$id retains frame/NULL/source population for $principal', async fixture => {
    const { principal } = fixture;
    const oracle = await source.query(principal === 'analyst' ? fixture.analystOracle : fixture.auditorOracle);
    const expected = oracle.rows.map(row => keys.map(key => row[key]));
    if (fixture.id === 'RUNNING') {
      expect(oracle.rows[0].grand).toBe(principal === 'analyst' ? 66 : 70066);
      expect(oracle.rows.find(row => row[keys[0]] === 'C').window).toBeNull();
      if (principal === 'analyst') {
        const mutant = await source.query(fixture.unpartitionedOracle!);
        expect(mutant.rows).not.toEqual(oracle.rows);
      }
    }
    if (fixture.id === 'ZERO-GRAND') expect(oracle.rows.every(row => row.grand === 0 && row.share === null)).toBe(true);
    const captures = [];

    for (const temperature of ['FIRST', 'REPEAT']) {
      const start = endpoint.sourceRequests.length;
      const result = await endpoint.execute(fixture.sql, principal);
      compare(result.rows, expected);
      expect(result.messages.find(message => message.schema)?.schema).toEqual(keys.map((name, index) => ({ name,
        column_type: ['String', 'Double', 'Double', 'Int64', 'Double', 'Double'][index] })));
      const issued = endpoint.sourceRequests.slice(start);
      expect(issued.length).toBeGreaterThan(0);

      for (const request of issued) {
        expect(request.principal).toBe(principal);
        expect(request.query).toContain('included = true');
        expect(request.query).not.toMatch(/\b(?:LIMIT|OFFSET)\b/i);
        if (principal === 'analyst') expect(request.values).toContain('A');
      }
      captures.push({ temperature, rows: result.rows, schema: result.messages.find(message => message.schema)?.schema, sourceRequests: issued });
    }
    console.log('combined ROWS source capture', JSON.stringify({ caseId: fixture.id, principal, captures }));
  });
});

import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

// Prepared endpoint regression only: run with each externally selected native
// stream mode after building the addon. No released-image qualification follows.
describe('native timestamp transport supported domain', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  beforeAll(async () => {
    endpoint = await startSemanticSqlEndpoint({
      model: () => `cube('temporal_events', {
        sql_table: 'temporal_events',
        dimensions: { id: { sql: 'id', type: 'number', primary_key: true }, event_time: { sql: 'event_time', type: 'time' } },
        measures: { count: { type: 'count' } },
        access_policy: [{ group: 'temporal_reader', member_level: { includes: '*' }, row_level: { allow_all: true } }],
      });`,
      setupSQL: "CREATE TABLE temporal_events(id INTEGER, event_time TIMESTAMP); INSERT INTO temporal_events VALUES (1, '1500-01-01'), (2, '2300-01-01'), (3, NULL), (4, '2026-01-01')",
      streamMode: process.env.CUBESQL_STREAM_MODE === 'true',
      grants: new Map([['reader', ['temporal_reader']]]),
    });
  });
  afterAll(async () => { await endpoint?.stop(); });
  test.each([1, 2])('refuses out-of-domain source timestamp id=%i on raw, grouped and nonnull-filtered paths', async id => {
    for (const query of [
      `SELECT event_time FROM temporal_events WHERE id = ${id}`,
      `SELECT DATE_TRUNC('day', event_time) AS day, MEASURE(count) FROM temporal_events WHERE id = ${id} GROUP BY 1`,
      `SELECT event_time FROM temporal_events WHERE id = ${id} AND event_time IS NOT NULL`,
    ]) {
      for (const temperature of ['first', 'repeat']) {
        const cursor = endpoint.sourceRequests.length;
        await expect(endpoint.execute(query, 'reader')).rejects.toThrow('TIMESTAMP_TRANSPORT_DOMAIN_UNSUPPORTED');
        expect(endpoint.sourceRequests.slice(cursor).length).toBeGreaterThan(0);
        console.log('Timestamp domain refusal', JSON.stringify({ query, temperature, streamMode: process.env.CUBESQL_STREAM_MODE, sourceRequests: endpoint.sourceRequests.slice(cursor) }));
      }
    }
  });
  test('retains genuine NULL and an in-domain coordinate', async () => {
    const missing = await endpoint.execute('SELECT event_time FROM temporal_events WHERE id = 3', 'reader');
    expect(missing.rows).toEqual([[null]]);
    const valid = await endpoint.execute('SELECT event_time FROM temporal_events WHERE id = 4', 'reader');
    expect(valid.rows).toHaveLength(1);
    expect(String(valid.rows[0]![0])).toContain('2026-01-01');
  });
});

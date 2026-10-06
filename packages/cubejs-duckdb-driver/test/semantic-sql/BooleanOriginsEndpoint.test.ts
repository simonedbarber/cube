import { createHash } from 'crypto';
import packet from './fixtures/boolean-origins-canonical-sql.json';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

/** Exact current QueryRails emission from the negative pinned MC11 captures.
 * Fixture SQL auth and DuckDB source remain boundaries; this is not a release
 * or production permission/cache qualification. */
describe('MC11 Boolean origins through the native SQL HTTP endpoint', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  beforeAll(async () => {
    endpoint = await startSemanticSqlEndpoint({ model: () => packet.modelSource,
      setupSQL: packet.setupSQL,
      streamMode: true,
      grants: new Map([['analyst', ['semantic_analyst']]]) });
    const population = await (await endpoint.connection.run(
      'SELECT COUNT(*) AS population FROM cssql_oracle.analytics_boolean_origins'
    )).getRowObjects();
    expect(Number(population[0]!.population)).toBe(10);
  });
  afterAll(async () => { await endpoint?.stop(); });

  async function actual(query: string) {
    const cursor = endpoint.sourceRequests.length;
    const result = await endpoint.execute(query, 'analyst');
    expect(result.messages.find(message => message.schema)?.schema).toEqual([
      { name: 'analytics_boolean_origins.id', column_type: 'Double' },
      { name: 'analytics_boolean_origins.count', column_type: 'Int64' },
    ]);
    const source = endpoint.sourceRequests.slice(cursor);
    expect(source.length).toBeGreaterThan(0);
    const rows = result.rows.map(row => row.map(value => Number(value)));
    console.log('MC11 native source capture', JSON.stringify({ query,
      rows,
      sourceRequests: source,
      modelHash: createHash('sha256').update(packet.modelSource).digest('hex'),
      evidenceBoundary: 'Private combined native addon and fixture source/auth; released PostgreSQL recapture remains required.' }));
    // A complete pushed-down small result may use the buffered source owner
    // even with native streaming enabled. Record its actual transport above.
    expect(source.every(request => request.completed && request.principal === 'analyst')).toBe(true);
    return rows;
  }

  test.each(packet.cases)('$id matches the unchanged independent population cold and warm', async fixture => {
    const oracle = await (await endpoint.connection.run(fixture.oracle)).getRowObjects();
    const expected = fixture.expectedIds.map(id => [id, 1]);
    expect(oracle.map(row => [Number(row.id), Number(row.count)])).toEqual(expected);
    expect(await actual(fixture.query)).toEqual(expected);
    expect(await actual(fixture.query)).toEqual(expected);
  });

  test.each(packet.cases)('$id retains explicitly NULL-inclusive predicate behavior separately', async fixture => {
    const query = fixture.query.replace('NOT(analytics_boolean_origins.flag = TRUE)',
      "(analytics_boolean_origins.flag != 'true' OR analytics_boolean_origins.flag IS NULL)");
    expect(query).not.toBe(fixture.query);
    const rows = await actual(query);
    expect(rows).toEqual(fixture.expectedWrongIds.map(id => [id, 1]));
    expect(rows).not.toEqual(fixture.expectedIds.map(id => [id, 1]));
  });
});

import packet from './fixtures/calendar-composition-canonical-sql.json';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

/** Frozen original-edge QueryRails SQL. Missing intermediate observed keys
 * are never recovered by substituting a flat offset. */
describe('MC13 authored calendar prior stages through the native SQL HTTP endpoint', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  beforeAll(async () => {
    endpoint = await startSemanticSqlEndpoint({ model: () => packet.modelSource,
      setupSQL: packet.setupSQL,
      streamMode: true,
      grants: new Map([['analyst', ['semantic_analyst']]]) });
  });
  afterAll(async () => { await endpoint?.stop(); });

  const date = (value: unknown) => (value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value).slice(0, 10));
  const metric = (value: unknown) => (value === null ? null : Number(value));
  const oracleRows = (rows: Record<string, unknown>[]) => rows.map(row => [date(row.bucket), metric(row.current), metric(row.prior), metric(row.prior_twice), metric(row.growth)]);

  test.each(packet.cases)('$id retains the original dense/sparse calendar graph on repeated requests', async fixture => {
    const truth = await (await endpoint.connection.run(fixture.oracle)).getRowObjects();
    expect(oracleRows(truth)).toEqual(fixture.expected);
    const mutant = await (await endpoint.connection.run(fixture.mutantOracle)).getRowObjects();
    expect(oracleRows(mutant)).not.toEqual(fixture.expected);

    for (const temperature of ['first', 'repeat']) {
      const cursor = endpoint.sourceRequests.length;
      const result = await endpoint.execute(fixture.query, 'analyst');
      expect(result.messages.find(message => message.schema)?.schema).toEqual([
        { name: 'analytics_calendar_months.observed_at', column_type: 'Timestamp' },
        ...['current', 'prior', 'prior_twice', 'growth'].map(name => ({ name, column_type: 'Double' })),
      ]);
      const actual = result.rows.map(row => [date(row[0]), ...row.slice(1).map(metric)]);
      const source = endpoint.sourceRequests.slice(cursor);
      expect(source.length).toBeGreaterThan(0);
      expect(source.every(request => request.completed && request.principal === 'analyst')).toBe(true);
      console.log('MC13 native original-edge capture', JSON.stringify({ caseId: fixture.id,
        temperature,
        query: fixture.query,
        rows: actual,
        sourceRequests: source,
        evidenceBoundary: packet.evidenceBoundary }));
      expect(actual).toEqual(fixture.expected);
    }
  });
});

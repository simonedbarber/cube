import packet from './fixtures/period-inputs-canonical-sql.json';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

/** Actual QueryRails emission and unchanged MC04 numeric targets. Fixture
 * source/auth and this private addon do not qualify a released runtime. */
describe('MC04 calendar and row populations through the native SQL HTTP endpoint', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  beforeAll(async () => {
    endpoint = await startSemanticSqlEndpoint({ model: () => packet.modelSource,
      setupSQL: packet.setupSQL,
      streamMode: true,
      grants: new Map([['analyst', ['semantic_analyst']]]) });
  });
  afterAll(async () => { await endpoint?.stop(); });

  const month = (value: unknown) => (value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`
    : String(value).slice(0, 7));

  test.each(packet.cases)('$id returns the exact calendar/row distinction on repeated requests', async fixture => {
    const truth = await (await endpoint.connection.run(fixture.oracle)).getRowObjects();
    const rows = (values: Record<string, unknown>[]) => values.map(row => [month(row.month), Number(row.current),
      row.prior === null ? null : Number(row.prior), row.growth === null ? null : Number(row.growth)]);
    expect(rows(truth)).toEqual(fixture.expected);
    const mutant = await (await endpoint.connection.run(fixture.mutantOracle)).getRowObjects();
    expect(rows(mutant)).not.toEqual(fixture.expected);

    for (const temperature of ['first', 'repeat']) {
      const cursor = endpoint.sourceRequests.length;
      const result = await endpoint.execute(fixture.query, 'analyst');
      expect(result.messages.find(message => message.schema)?.schema).toEqual([
        { name: 'analytics_period_inputs.observed_at', column_type: 'Timestamp' },
        { name: 'current', column_type: 'Double' }, { name: 'prior', column_type: 'Double' },
        { name: 'growth', column_type: 'Double' },
      ]);
      const actual = result.rows.map(row => [month(row[0]), Number(row[1]),
        row[2] === null ? null : Number(row[2]), row[3] === null ? null : Number(row[3])]);
      const source = endpoint.sourceRequests.slice(cursor);
      expect(source.length).toBeGreaterThan(0);
      expect(source.every(request => request.completed && request.principal === 'analyst')).toBe(true);
      console.log('MC04 native source capture', JSON.stringify({ caseId: fixture.id,
        temperature,
        query: fixture.query,
        rows: actual,
        sourceRequests: source,
        evidenceBoundary: packet.evidenceBoundary }));
      expect(actual).toEqual(fixture.expected);
    }
  });
});

import packet from './fixtures/precision-canonical-sql.json';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

/** Frozen original MC18 SQL and independently captured PostgreSQL exact truth.
 * No Number coercion, source export, application calculation or changed target.
 * DuckDB fixture source does not establish PostgreSQL/released-image parity. */
describe('Exact MC18 source and residual precision through native SQL HTTP', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  beforeAll(async () => {
    endpoint = await startSemanticSqlEndpoint({ model: () => packet.modelSource,
      setupSQL: packet.setupSQL,
      streamMode: true,
      grants: new Map([['analyst', ['semantic_analyst']]]) });
  });
  afterAll(async () => { await endpoint?.stop(); });

  test('records the existing sql4sql full-pushdown candidate for the original large integer', async () => {
    const fixture = packet.cases.find(candidate => candidate.id === 'SYN-MC18-EXACT-LARGE-INTEGER-SOURCE-FIRST')!;
    const source = await endpoint.compileSourceSql(fixture.query, 'analyst');
    console.log('MC18 source-pushdown candidate', JSON.stringify({ query: fixture.query, source }));
    expect(source).not.toHaveProperty('error');
    // The existing binding returns its SQL tuple despite the older JS response
    // declaration describing separate sql/values fields. Validate the wire data.
    const tuple: unknown = Reflect.get(source, 'sql');
    if (!Array.isArray(tuple) || typeof tuple[0] !== 'string' || !Array.isArray(tuple[1])) throw new Error('No source SQL tuple');
    const values = tuple[1].map((value: unknown) => {
      if (value !== null && typeof value !== 'string') throw new Error('Invalid source SQL parameter');
      return value;
    });
    const result = await endpoint.connection.run(tuple[0], values);
    const rows = await result.getRowObjects();
    console.log('MC18 source-pushdown candidate rows', JSON.stringify(rows, (_, value) => (typeof value === 'bigint' ? value.toString() : value)));
  });

  test.each(packet.cases)('$id preserves original wire values before display formatting', async fixture => {
    expect(fixture.postgresOracleRows).toEqual(fixture.expected);
    const names = fixture.fields.map(field => field.name);
    const expectedRows = fixture.expected.map((row: Record<string, unknown>) => names.map(name => row[name]));
    const schema = fixture.fields.map(field => ({ name: field.name,
      column_type: field.dataTypeId === 20 ? 'Int64' : 'Decimal(38, 9)' }));

    for (const temperature of ['FIRST', 'REPEAT']) {
      const cursor = endpoint.sourceRequests.length;
      const actual = await endpoint.execute(fixture.query, 'analyst');
      console.log('MC18 exact native capture', JSON.stringify({ caseId: fixture.id,
        temperature,
        schema: actual.messages.find(message => message.schema)?.schema,
        rows: actual.rows,
        sourceRequests: endpoint.sourceRequests.slice(cursor) }));
      expect(actual.rows).toEqual(expectedRows);
      expect(actual.messages.find(message => message.schema)?.schema).toEqual(schema);
      const requests = endpoint.sourceRequests.slice(cursor);
      if (fixture.owner === 'residual') expect(requests).toHaveLength(0);
      else {
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every(request => request.completed && request.principal === 'analyst')).toBe(true);
        expect(requests.every(request => request.query.includes('tenant') && request.values.includes('A'))).toBe(true);
      }
    }
  });
});

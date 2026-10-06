import { createHash } from 'crypto';
import packet from './fixtures/precision-canonical-sql.json';
import numericModel from './fixtures/precision-numeric-model.json';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

/** Original MC18 SQL/PG truth. Only the model's explicit aggregate RESULT types
 * change; no source export, JS arithmetic, convenient-grain SQL or new oracle. */
describe('Declared exact numeric results through native SQL HTTP', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  beforeAll(async () => {
    expect(createHash('sha256').update(packet.modelSource).digest('hex')).toBe(numericModel.originalModelSourceSha256);
    endpoint = await startSemanticSqlEndpoint({ model: () => numericModel.typedModelSource,
      setupSQL: packet.setupSQL,
      streamMode: true,
      grants: new Map([['analyst', ['semantic_analyst']]]) });
  });
  afterAll(async () => { await endpoint?.stop(); });

  test.each(packet.cases)('$id preserves exact original values with declared result types', async fixture => {
    expect(fixture.postgresOracleRows).toEqual(fixture.expected);
    const names = fixture.fields.map(field => field.name);
    const expectedRows = fixture.expected.map((row: Record<string, unknown>) => names.map(name => row[name]));
    const schema = fixture.fields.map(field => ({ name: field.name,
      column_type: field.dataTypeId === 20 ? 'Int64' : 'Decimal(38, 9)' }));

    for (const temperature of ['FIRST', 'REPEAT']) {
      const cursor = endpoint.sourceRequests.length;
      const actual = await endpoint.execute(fixture.query, 'analyst');
      console.log('MC18 typed numeric capture', JSON.stringify({ caseId: fixture.id,
        temperature,
        query: fixture.query,
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

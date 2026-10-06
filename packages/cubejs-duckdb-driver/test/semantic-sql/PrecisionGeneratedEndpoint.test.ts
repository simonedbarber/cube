import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { performance } from 'perf_hooks';
import packet from './fixtures/precision-canonical-sql.json';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

/** Original MC18 SQL and independently verified PG truth, with declarations
 * emitted by QueryRails from the owned source's real catalog. No handwritten
 * type fallback, source export, JS arithmetic, changed population or oracle. */
describe('Production-generated numeric results through native SQL HTTP', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  beforeAll(async () => {
    const path = process.env.QUERYRAILS_MC18_GENERATED_MODEL_PATH;
    if (!path) throw new Error('Generate the MC18 production adapter/emitter artifact before this native capture');
    const generated = JSON.parse(readFileSync(path, 'utf8'));
    expect(createHash('sha256').update(packet.modelSource).digest('hex')).toBe(generated.originalModelSourceSha256);
    expect(generated.producerSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(generated.emitterSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(generated.declarations).toHaveLength(15);
    const metadata = /, meta: \{ result_semantics: \{ numeric: \{[^{}]+\} \} \}/g;
    expect(generated.typedModelSource.match(metadata)).toHaveLength(15);
    expect(generated.typedModelSource.replace(metadata, '')).toBe(packet.modelSource);
    endpoint = await startSemanticSqlEndpoint({
      model: () => generated.typedModelSource,
      setupSQL: packet.setupSQL,
      streamMode: true,
      grants: new Map([['analyst', ['semantic_analyst']]])
    });
  });
  afterAll(async () => { await endpoint?.stop(); });

  test.each(packet.cases)('$id preserves exact original values with production-generated result types', async fixture => {
    expect(fixture.postgresOracleRows).toEqual(fixture.expected);
    const names = fixture.fields.map(field => field.name);
    const expectedRows = fixture.expected.map((row: Record<string, unknown>) => names.map(name => row[name]));
    const schema = fixture.fields.map(field => ({ name: field.name,
      column_type: field.dataTypeId === 20 ? 'Int64' : 'Decimal(38, 9)' }));

    for (const temperature of ['FIRST', 'REPEAT']) {
      const cursor = endpoint.sourceRequests.length;
      const started = performance.now();
      const actual = await endpoint.execute(fixture.query, 'analyst');
      const wallTimeMs = performance.now() - started;
      console.log('MC18 production-generated numeric capture', JSON.stringify({
        caseId: fixture.id,
        temperature,
        query: fixture.query,
        schema: actual.messages.find(message => message.schema)?.schema,
        rows: actual.rows,
        wallTimeMs,
        sourceRequests: endpoint.sourceRequests.slice(cursor)
      }));
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

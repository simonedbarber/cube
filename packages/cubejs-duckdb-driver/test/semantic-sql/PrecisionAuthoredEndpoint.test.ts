import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { performance } from 'perf_hooks';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

type Fixture = {
  id: string;
  query: string;
  sql: string;
  document: unknown;
  ir: unknown;
  fields: Array<{ name: string; column_type: string }>;
  expectedRows: Array<Array<string | null>>;
};

/** Actual production-compiler output. No handwritten candidate SQL, result
 * formatting or float tolerance. Public admission remains independently gated. */
describe('Compiler-authored decimals through native SQL HTTP', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  let packet: { fixtureSha256: string; emitterSha256: string; compilerRevision: number; originalModelSourceSha256: string; setupSQL: string; cases: Fixture[] };
  beforeAll(async () => {
    const authoredPath = process.env.QUERYRAILS_MC18_AUTHORED_PACKET_PATH;
    const modelPath = process.env.QUERYRAILS_MC18_GENERATED_MODEL_PATH;
    if (!authoredPath || !modelPath) throw new Error('Generate compiler candidates and the production numeric model before native capture');
    packet = JSON.parse(readFileSync(authoredPath, 'utf8'));
    const generated = JSON.parse(readFileSync(modelPath, 'utf8'));
    expect(packet.fixtureSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(packet.emitterSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(packet.compilerRevision).toBe(3);
    expect(packet.originalModelSourceSha256).toBe(generated.originalModelSourceSha256);
    expect(generated.declarations).toHaveLength(15);
    expect(packet.cases).toHaveLength(3);
    endpoint = await startSemanticSqlEndpoint({
      model: () => generated.typedModelSource,
      setupSQL: packet.setupSQL,
      streamMode: true,
      grants: new Map([['analyst', ['semantic_analyst']]]) });
  });
  afterAll(async () => { await endpoint?.stop(); });

  test.each(['SYN-MC18-AUTHORED-SAFE-DIVISION', 'SYN-MC18-AUTHORED-DECIMAL-ARITHMETIC', 'SYN-MC18-AUTHORED-EXACT-LARGE-INTEGER'])(
    '%s retains exact values, output types and authorized source inputs', async id => {
      const fixture = packet.cases.find(candidate => candidate.id === id);
      if (!fixture) throw new Error(`Missing compiler-authored fixture ${id}`);
      expect(fixture.document).toBeDefined();
      expect(fixture.ir).toBeDefined();
      expect(fixture.query).not.toMatch(/DOUBLE PRECISION|1e0/);

      for (const temperature of ['FIRST', 'REPEAT']) {
        const cursor = endpoint.sourceRequests.length;
        const started = performance.now();
        const actual = await endpoint.execute(fixture.query, 'analyst');
        const requests = endpoint.sourceRequests.slice(cursor);
        console.log('MC18 compiler-authored numeric capture', JSON.stringify({
          caseId: fixture.id,
          temperature,
          query: fixture.query,
          sqlSha256: createHash('sha256').update(fixture.sql).digest('hex'),
          fixtureSha256: packet.fixtureSha256,
          emitterSha256: packet.emitterSha256,
          compilerRevision: packet.compilerRevision,
          schema: actual.messages.find(message => message.schema)?.schema,
          rows: actual.rows,
          wallTimeMs: performance.now() - started,
          sourceRequests: requests
        }));
        expect(actual.rows).toEqual(fixture.expectedRows);
        expect(actual.messages.find(message => message.schema)?.schema).toEqual(fixture.fields);
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every(request => request.completed && request.principal === 'analyst')).toBe(true);
        expect(requests.every(request => request.query.includes('tenant') && request.values.includes('A'))).toBe(true);
      }
    }
  );
});

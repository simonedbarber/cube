import { readFileSync } from 'fs';
import { performance } from 'perf_hooks';
import packet from './fixtures/precision-canonical-sql.json';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

/** Int64 mathematical boundaries through the actual native residual cast, not
 * source decoder tests. Existing MC18 SQL/oracles are untouched. */
describe('Native decimal to Int64 cast boundaries', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  beforeAll(async () => {
    const path = process.env.QUERYRAILS_MC18_GENERATED_MODEL_PATH;
    if (!path) throw new Error('Generate the production numeric fixture artifact first');
    const generated = JSON.parse(readFileSync(path, 'utf8'));
    endpoint = await startSemanticSqlEndpoint({
      model: () => generated.typedModelSource,
      setupSQL: packet.setupSQL,
      streamMode: true,
      grants: new Map([['analyst', ['semantic_analyst']]])
    });
  });
  afterAll(async () => { await endpoint?.stop(); });

  test.each([0, 9])('retains exact signed Int64 boundaries and NULL at decimal scale %i', async scale => {
    const query = `SELECT CAST(CAST(9223372036854775807 AS DECIMAL(38,${scale})) AS BIGINT) AS maximum,
      CAST(CAST(-9223372036854775808 AS DECIMAL(38,${scale})) AS BIGINT) AS minimum,
      CAST(CAST(NULL AS DECIMAL(38,${scale})) AS BIGINT) AS missing LIMIT 10`;
    const cursor = endpoint.sourceRequests.length;
    const started = performance.now();
    const result = await endpoint.execute(query, 'analyst');
    const wallTimeMs = performance.now() - started;
    expect(result.rows).toEqual([['9223372036854775807', '-9223372036854775808', null]]);
    expect(result.messages.find(message => message.schema)?.schema).toEqual([
      { name: 'maximum', column_type: 'Int64' }, { name: 'minimum', column_type: 'Int64' }, { name: 'missing', column_type: 'Int64' },
    ]);
    expect(endpoint.sourceRequests.slice(cursor)).toHaveLength(0);
    console.log('Native Int64 boundary capture', JSON.stringify({
      scale,
      query,
      rows: result.rows,
      schema: result.messages.find(message => message.schema)?.schema,
      wallTimeMs,
      sourceRequests: []
    }));
  });

  test.each([0, 9].flatMap(scale => ['9223372036854775808', '-9223372036854775809'].map(value => ({ scale, value }))))(
    'rejects out-of-range $value at scale $scale instead of wrapping or rounding', async ({ value, scale }) => {
      const query = `SELECT CAST(CAST(${value} AS DECIMAL(38,${scale})) AS BIGINT) AS overflow LIMIT 10`;
      const cursor = endpoint.sourceRequests.length;
      const started = performance.now();
      let failure: Error | undefined;

      try {
        const accepted = await endpoint.execute(query, 'analyst');
        console.log('Native Int64 overflow incorrectly accepted', JSON.stringify({
          value,
          scale,
          query,
          rows: accepted.rows,
          schema: accepted.messages.find(message => message.schema)?.schema,
          wallTimeMs: performance.now() - started,
          sourceRequests: endpoint.sourceRequests.slice(cursor)
        }));
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        failure = error;
      }
      const wallTimeMs = performance.now() - started;
      expect(failure).toBeDefined();
      expect(failure!.message).toMatch(/out of range|overflow/i);
      expect(endpoint.sourceRequests.slice(cursor)).toHaveLength(0);
      console.log('Native Int64 overflow rejection', JSON.stringify({
        value,
        scale,
        query,
        error: failure!.message,
        wallTimeMs,
        sourceRequests: []
      }));
    },
  );
});

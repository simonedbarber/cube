import canonicalPacket from './fixtures/retained-total-state-canonical-sql.json';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

const originalModel = canonicalPacket.modelSource;
const sourceProjection = 'SELECT * FROM cssql_oracle.analytics_retained_state';
const changedProjection = 'SELECT id, region, person, channel, amount + 1 AS amount FROM cssql_oracle.analytics_retained_state';
const changedModel = originalModel.replace(sourceProjection, changedProjection);
const target = canonicalPacket.singleMeasures.find(fixture => fixture.id === 'AVERAGE-ONLY')!;

/** The same SQL and source rows must use the CURRENT compiled definition. The
 * adapter deliberately omits a source-result cache; this covers the real
 * compiler/metadata/rewrite/native cache owners, not orchestrator result caching
 * or QueryRails permission/cache authority. */
describe('Model revision through the semantic SQL HTTP endpoint', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  let model = originalModel;
  let version = 'retained-state-original';
  let versionReads = 0;
  let modelReads = 0;

  beforeAll(async () => {
    expect(changedModel).not.toBe(originalModel);
    expect(originalModel.split(sourceProjection)).toHaveLength(2);
    endpoint = await startSemanticSqlEndpoint({
      model: () => { modelReads++; return model; },
      schemaVersion: async () => { versionReads++; return version; },
      setupSQL: canonicalPacket.setupSQL,
      streamMode: true,
      grants: new Map([['auditor', ['auditor']]]),
    });
  });
  afterAll(async () => { await endpoint?.stop(); });

  async function actual() {
    const cursor = endpoint.sourceRequests.length;
    const result = await endpoint.execute(target.sql, 'auditor');
    expect(result.messages.find(message => message.schema)?.schema).toEqual(target.fields);
    const source = endpoint.sourceRequests.slice(cursor);
    expect(source.length).toBeGreaterThan(0);
    expect(source.every(request => request.completed && request.principal === 'auditor')).toBe(true);
    expect(source.every(request => !/\b(?:LIMIT|OFFSET)\b/i.test(request.query))).toBe(true);
    const rows = result.rows.map(row => row.map(value => (value === null ? null : Number(value))));
    console.log('model revision native source capture', JSON.stringify({
      version, versionReads, modelReads, rows, sourceRequests: source,
    }));
    return { rows, source };
  }

  async function oracle(changed: boolean) {
    const sql = changed ? target.oracleSql.replace(
      'SELECT * FROM cssql_oracle.analytics_retained_state', changedProjection,
    ) : target.oracleSql;
    if (changed) expect(sql).not.toBe(target.oracleSql);
    const rows = await (await endpoint.connection.run(sql)).getRowObjects();
    return rows.map(row => [row.average === null ? null : Number(row.average)]);
  }

  test('warms the original native plan with the independent retained average', async () => {
    expect(await oracle(false)).toEqual([[19]]);
    expect((await actual()).rows).toEqual([[19]]);
    const compiledReads = modelReads;
    expect((await actual()).rows).toEqual([[19]]);
    expect(modelReads).toBe(compiledReads);
    expect(versionReads).toBeGreaterThan(1);
  });

  test('the unchanged-version control retains the old compiled meaning', async () => {
    model = changedModel;
    expect(await oracle(true)).toEqual([[11]]);
    const compiledReads = modelReads;
    const control = await actual();
    expect(control.rows).toEqual([[19]]);
    expect(control.rows).not.toEqual([[11]]);
    expect(modelReads).toBe(compiledReads);
    expect(control.source.every(request => !request.query.includes('amount + 1'))).toBe(true);
  });

  test('a version bump refreshes metadata and native plans for identical authored SQL', async () => {
    version = 'retained-state-changed';
    const compiledReads = modelReads;
    const result = await actual();
    expect(result.rows).toEqual(await oracle(true));
    expect(result.rows).toEqual([[11]]);
    expect(modelReads).toBeGreaterThan(compiledReads);
    expect(result.source.every(request => request.query.includes('amount + 1'))).toBe(true);
    const currentReads = modelReads;
    expect((await actual()).rows).toEqual([[11]]);
    expect(modelReads).toBe(currentReads);
  });

  test('restoring a definition under another revision cannot reuse the changed plan', async () => {
    model = originalModel;
    version = 'retained-state-restored';
    const result = await actual();
    expect(result.rows).toEqual(await oracle(false));
    expect(result.rows).toEqual([[19]]);
    expect(result.source.every(request => !request.query.includes('amount + 1'))).toBe(true);
  });
});

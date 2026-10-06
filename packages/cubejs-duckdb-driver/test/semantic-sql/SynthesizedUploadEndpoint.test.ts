import { execFile } from 'child_process';
import { createServer } from 'http';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import * as jwt from 'jsonwebtoken';
import { PostgresDriver } from '@cubejs-backend/postgres-driver';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

// Independently authored PostgreSQL truth. Source writes are confined to the
// owned local serving tables below; this query uses only typed VALUES on Neon.
const referenceSql = `WITH orders(identity, id, amount) AS (VALUES
  ('order-a', 1, 9007199254740993.123456789::numeric(38,9)),
  ('order-b', 2, 9007199254740993.123456789::numeric(38,9)), ('order-c', 3, NULL::numeric(38,9))),
lines(identity, order_id, category) AS (VALUES
  ('line-a',1,'A'),('line-b',1,'A'),('line-c',2,'A'),('line-d',2,'A'),('orphan',999,'B')),
population AS MATERIALIZED (SELECT o.identity, o.amount, l.identity AS line_identity, l.category
  FROM orders o LEFT JOIN lines l ON l.order_id = o.id),
order_state AS (SELECT category, sum(amount)::numeric(38,9) AS amount, count(*) AS orders
  FROM (SELECT DISTINCT identity, amount, category FROM population) p GROUP BY category),
line_state AS (SELECT category, count(DISTINCT line_identity) AS lines FROM population GROUP BY category)
SELECT o.category, o.amount::text AS amount, o.orders::text AS orders, l.lines::text AS lines
FROM order_state o JOIN line_state l ON l.category IS NOT DISTINCT FROM o.category
ORDER BY o.category ASC NULLS LAST`;

const setupSQL = `ATTACH ':memory:' AS s0; ATTACH ':memory:' AS s1;
CREATE SCHEMA s0.imports; CREATE SCHEMA s1.imports;
CREATE TABLE s1.imports.orders_version_1 (_dlt_id VARCHAR NOT NULL UNIQUE, id BIGINT, amount DECIMAL(38,9));
INSERT INTO s1.imports.orders_version_1 VALUES ('order-a',1,9007199254740993.123456789),('order-b',2,9007199254740993.123456789),('order-c',3,NULL);
CREATE TABLE s0.imports.lines_version_1 (_dlt_id VARCHAR NOT NULL UNIQUE, order_id BIGINT, category VARCHAR);
INSERT INTO s0.imports.lines_version_1 VALUES ('line-a',1,'A'),('line-b',1,'A'),('line-c',2,'A'),('line-d',2,'A'),('orphan',999,'B');`;

describe('Actual upload synthesis through native Cube and the application parent', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  let source: PostgresDriver;
  let packet: {
    caseId: string;
    blendId: string;
    query: string;
    sql: string;
    emitterSource: string;
    payload: unknown;
    fixtureSha256: string;
  };
  let expected: Array<Array<string | null>>;
  let overlayExpected: Array<Array<string | null>>;
  let schemaRevision = 1;
  let metadata: { cubes: Array<{ name: string; dimensions: Array<{ name: string }> }> };
  const expectedSchema = [
    { name: 'lines.category', column_type: 'String' },
    { name: 'orders.amount_sum', column_type: 'Decimal(38, 9)' },
    { name: 'orders.count', column_type: 'Int64' },
    { name: 'lines.count', column_type: 'Int64' }
  ];
  const compileSecret = 'fixture-only-upload-compile-secret';
  const callbacks: Array<{ path: string; verified: boolean }> = [];
  const compileServer = createServer((req, res) => {
    try {
      jwt.verify((req.headers.authorization ?? '').replace(/^Bearer /, ''), compileSecret, {
        algorithms: ['HS256'],
        issuer: 'cube-service',
        audience: 'queryrails-api',
        subject: 'cube'
      });
      if (req.url !== `/api/internal/cube/tenants/tenant-1/blends/${packet.blendId}/models?scope=published`) {
        throw new Error('Unexpected owned compile path');
      }
      callbacks.push({ path: req.url, verified: true });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(packet.payload));
    } catch {
      res.writeHead(403);
      res.end();
    }
  });
  beforeAll(async () => {
    const packetPath = process.env.QUERYRAILS_UPLOAD_CUBE_PACKET_PATH;
    const sourceUrl = process.env.DATABASES_DIRECT_URL;
    if (!packetPath || !sourceUrl) {
      throw new Error('Owned upload candidate and existing independent reference connection are required');
    }
    packet = JSON.parse(readFileSync(packetPath, 'utf8'));
    const url = new URL(sourceUrl);
    url.pathname = '/tpc_h';
    source = new PostgresDriver({
      connectionString: url.toString(),
      readOnly: true,
      maxPoolSize: 1,
      options: '-c default_transaction_read_only=on -c statement_timeout=30000',
      executionTimeout: 30
    });
    const truth = await source.query<{ category: string | null; amount: string | null; orders: string; lines: string }>(
      referenceSql,
      []
    );
    expected = truth.map((row) => [row.category, row.amount, row.orders, row.lines]);
    expect(expected).toEqual([
      ['A', '18014398509481986.246913578', '2', '4'],
      [null, null, '1', '0']
    ]);
    const overlayReferenceSql = referenceSql.replace(
      'FROM orders o LEFT JOIN lines l ON l.order_id = o.id)',
      "FROM orders o LEFT JOIN lines l ON l.order_id = o.id WHERE l.category = 'A')"
    );
    expect(overlayReferenceSql).not.toBe(referenceSql);
    overlayExpected = (
      await source.query<{ category: string | null; amount: string | null; orders: string; lines: string }>(overlayReferenceSql, [])
    ).map((row) => [row.category, row.amount, row.orders, row.lines]);
    expect(overlayExpected).toEqual([['A', '18014398509481986.246913578', '2', '4']]);
    const mutationSql = [
      referenceSql.replace('SELECT DISTINCT identity, amount, category', 'SELECT identity, amount, category'),
      referenceSql.replace('sum(amount)', 'sum(DISTINCT amount)')
    ];
    const mutations: Array<{ sql: string; rows: Array<Array<string | null>> }> = [];

    for (const sql of mutationSql) {
      const rows = (
        await source.query<{ category: string | null; amount: string | null; orders: string; lines: string }>(sql, [])
      ).map((row) => [row.category, row.amount, row.orders, row.lines]);
      expect(rows).not.toEqual(expected);
      mutations.push({ sql, rows });
    }
    expect(mutations[0].rows[0]).toEqual(['A', '36028797018963972.493827156', '4', '4']);
    expect(mutations[1].rows[0]).toEqual(['A', '9007199254740993.123456789', '2', '4']);
    await new Promise<void>((resolve) => compileServer.listen(0, '127.0.0.1', resolve));
    const address = compileServer.address();
    if (!address || typeof address === 'string') throw new Error('Missing owned upload compile port');
    const context = {
      tenantId: 'tenant-1',
      blendContext: true,
      blendId: packet.blendId,
      cubeScope: 'published',
      env: { INTERNAL_SERVICE_SECRET: compileSecret, APP_DOMAIN: `http://127.0.0.1:${address.port}` }
    };
    const reader = { tenantId: 'tenant-1', blendOperandReach: ['orders', 'lines'] };
    endpoint = await startSemanticSqlEndpoint({
      model: () => packet.emitterSource,
      setupSQL,
      streamMode: true,
      schemaVersion: () => String(schemaRevision),
      compileContext: { securityContext: context },
      grants: new Map(['reader', 'organization', 'partial', 'denied', 'foreign'].map((id) => [id, ['reader']])),
      securityContexts: new Map<string, Record<string, unknown>>([
        ['reader', reader],
        ['organization', { ...reader, consumerType: 'organization', consumerOrgId: 'org-both' }],
        ['partial', { ...reader, consumerType: 'organization', consumerOrgId: 'org-orders' }],
        ['denied', { ...reader, consumerType: 'organization', consumerOrgId: 'org-denied' }],
        ['foreign', { ...reader, tenantId: 'another-tenant' }]
      ])
    });
    const response = await fetch(endpoint.url.replace(/\/cubesql$/, '/meta?extended'), {
      headers: { Authorization: 'reader' },
      signal: AbortSignal.timeout(30000)
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `Upload metadata ${response.status}: ${body}; callbacks=${JSON.stringify(callbacks)}; logs=${JSON.stringify(
          endpoint.logs.slice(-4)
        )}`
      );
    }
    metadata = JSON.parse(body);
    console.log('Synthesized upload extended metadata', JSON.stringify(metadata));
    expect(metadata.cubes.map((cube) => cube.name)).toEqual(expect.arrayContaining(['orders', 'lines']));
    expect(
      metadata.cubes.flatMap((cube) => cube.dimensions).some((dimension) => /(?:^|[._])row_id$/.test(dimension.name))
    ).toBe(false);
    expect(JSON.stringify(metadata)).not.toContain('_dlt_id');
    expect(callbacks.length).toBeGreaterThan(0);
    expect(callbacks.every((callback) => callback.verified)).toBe(true);
    console.log(
      'Synthesized upload independent reference capture',
      JSON.stringify({
        caseId: packet.caseId,
        fixtureSha256: packet.fixtureSha256,
        referenceSql,
        overlayReferenceSql,
        overlayExpected,
        independentExpected: expected,
        mutations,
        expectedSchema,
        metadata,
        callbacks,
        emitterSha256: createHash('sha256').update(packet.emitterSource).digest('hex'),
        evidenceBoundary:
          'Actual production async emitter over a verified owned compile callback and local immutable serving tables with _dlt_id. Independent read-only PostgreSQL VALUES oracle. Platform ingestion/published DB/grants, snapshots and runtime release are not qualified.'
      })
    );
  });
  afterAll(async () => {
    try {
      await endpoint?.stop();
      await source?.release();
    } finally {
      if (compileServer.listening) {
        compileServer.closeAllConnections();
        await new Promise<void>((resolve) => compileServer.close(() => resolve()));
      }
    }
  });

  test('keeps private upload identities inside native joined aggregation', async () => {
    const actual = await endpoint.execute(packet.query, 'reader');
    expect(actual.rows).toEqual(expected);
    expect(actual.messages.find((message) => message.schema)?.schema).toEqual(expectedSchema);
    expect(endpoint.sourceRequests.every((request) => request.completed)).toBe(true);
    expect(endpoint.sourceRequests.some((request) => request.query.includes('_dlt_id'))).toBe(true);
    console.log(
      'Synthesized upload native capture',
      JSON.stringify({
        caseId: packet.caseId,
        rows: actual.rows,
        schema: actual.messages.find((message) => message.schema)?.schema,
        sourceRequests: endpoint.sourceRequests
      })
    );
  });

  test('enforces the actual emitted tenant, grant and operand policies', async () => {
    expect((await endpoint.execute(packet.query, 'organization')).rows).toEqual(expected);
    const deniedCaptures: Array<{ principal: string; error: string; sourceDispatches: number }> = [];

    for (const principal of ['partial', 'denied', 'foreign']) {
      const before = endpoint.sourceRequests.length;
      let refusal: Error | undefined;

      try {
        await endpoint.execute(packet.query, principal);
      } catch (error) {
        refusal = error as Error;
      }
      // Actual grant policies remove inaccessible cubes from native metadata.
      // Retain federation's current pre-source planning refusal; do not invent
      // a NULL answer or a cannot-serve fallback category for denied reach.
      expect(refusal?.message).toMatch(/Table or CTE with name '(?:lines|orders)' not found/);
      expect(endpoint.sourceRequests).toHaveLength(before);
      deniedCaptures.push({
        principal,
        error: refusal!.message,
        sourceDispatches: endpoint.sourceRequests.length - before
      });
    }
    console.log('Synthesized upload denied policy capture', JSON.stringify(deniedCaptures));
    const cursor = endpoint.sourceRequests.length;
    expect((await endpoint.request(packet.query, 'unknown')).status).toBe(403);
    expect(endpoint.sourceRequests).toHaveLength(cursor);
  });

  test('does not promote an explicitly included private key through a view', async () => {
    const payload = packet.payload as { views: Array<{ cubes: Array<{ includes: unknown[] }> }> };

    for (const view of payload.views) for (const cube of view.cubes) cube.includes.push('row_id');
    schemaRevision++;
    const response = await fetch(endpoint.url.replace(/\/cubesql$/, '/meta?extended'), {
      headers: { Authorization: 'reader' },
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Mutated upload metadata ${response.status}: ${await response.text()}`);
    const actual = (await response.json()) as typeof metadata;
    expect(
      actual.cubes.flatMap((cube) => cube.dimensions).some((dimension) => /(?:^|[._])row_id$/.test(dimension.name))
    ).toBe(false);
    expect(actual.cubes.some((cube) => cube.name === 'blend_owned_upload_defined_fixture')).toBe(true);
    console.log(
      'Synthesized upload explicit private include capture',
      JSON.stringify({
        caseId: packet.caseId,
        privateIncludes: payload.views.map((view) => view.cubes.map((cube) => cube.includes)),
        dimensions: actual.cubes.flatMap((cube) => cube.dimensions).map((dimension) => dimension.name)
      })
    );

    // Restore the actual production payload before the parent comparison.
    for (const view of payload.views) for (const cube of view.cubes) cube.includes.pop();
    schemaRevision++;
  });

  test('feeds native upload state through actual canonical preparation and the parent Fleet wire', async () => {
    const applicationRoot = process.env.QUERYRAILS_APPLICATION_ROOT;
    if (!applicationRoot) throw new Error('The application root is required');
    const directory = mkdtempSync(join(tmpdir(), 'qr-upload-parent-wire-'));
    const capturePath = join(directory, 'capture.json');
    const preparedPath = join(directory, 'candidate.json');
    const cursor = endpoint.sourceRequests.length;

    try {
      writeFileSync(preparedPath, JSON.stringify({ ...packet, meta: metadata }));
      await promisify(execFile)(
        process.execPath,
        [
          join(applicationRoot, 'apps/api/node_modules/vitest/vitest.mjs'),
          'run',
          'src/test/semantic-parity-integration/neon-blend-fleet-wire.integration.test.ts'
        ],
        {
          cwd: join(applicationRoot, 'apps/api'),
          timeout: 60000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            QUERYRAILS_NEON_BLEND_PACKET_PATH: preparedPath,
            QUERYRAILS_NEON_CUBE_URL: endpoint.url.replace(/\/cubesql$/, ''),
            QUERYRAILS_NEON_EXPECTED_ROWS: JSON.stringify(expected),
            QUERYRAILS_NEON_OVERLAY_EXPECTED_ROWS: JSON.stringify(overlayExpected),
            QUERYRAILS_NEON_EXPECTED_SCHEMA: JSON.stringify(expectedSchema),
            QUERYRAILS_NEON_WIRE_CAPTURE_PATH: capturePath
          }
        }
      );
      const capture = JSON.parse(readFileSync(capturePath, 'utf8'));
      const requests = endpoint.sourceRequests.slice(cursor);
      expect(requests).toHaveLength(6);
      expect(requests[0]).toMatchObject({ completed: true, rowCount: 2, principal: 'reader' });
      expect(requests[1]).toMatchObject({ completed: true, rowCount: 2, principal: 'reader' });
      expect(requests[2]).toMatchObject({ completed: true, rowCount: 2, principal: 'reader' });
      expect(requests[3]).toMatchObject({ completed: true, rowCount: 2, principal: 'reader' });
      expect(requests[4]).toMatchObject({ completed: true, rowCount: 2, principal: 'reader' });
      expect(requests[5]).toMatchObject({ completed: true, rowCount: 1, principal: 'reader' });
      expect(capture.savedConsumer.result.rows).toEqual(capture.rows);
      expect(capture.savedConsumer.result).toMatchObject({ queryVersionId: 'native-saved-federation', executionId: 'native-neon-parent-2', authoredBlendRevision: 3, blendRevision: 5 });
      expect(capture.savedConsumer.postProcessingRefusal).toMatchObject({ code: 'TABULAR_RUNTIME_UNQUALIFIED', dataDispatches: 0, fallbackDispatches: 0 });
      expect(capture.exportConsumer.result.rows).toEqual(capture.rows);
      expect(capture.exportConsumer.delivered).toMatchObject({ status: 'completed', rowCount: 2, truncated: false });
      expect(capture.exportConsumer.missingReadPermission).toMatchObject({ status: 403, dataDispatches: 0, ledgers: 0, uploads: 0 });
      expect(capture.scheduledConsumer.result.rows).toEqual(capture.rows);
      expect(capture.scheduledConsumer.result.executionId).toBe('native-neon-parent-4');
      expect(capture.scheduledConsumer.changedAfterClaim).toMatchObject({ status: 422, dataDispatches: 0, ledgers: 0, reports: 0 });
      expect(capture.chartConsumer.result.data.rows).toEqual(capture.rows);
      expect(capture.chartConsumer.result.data.executionId).toBe('native-neon-parent-5');
      expect(capture.chartConsumer.dashboardOverlay.independentExpected).toEqual(overlayExpected);
      expect(capture.chartConsumer.dashboardOverlay.result.data.rowCount).toBe(1);
      expect(capture.chartConsumer.additionalRefusalDataDispatches).toBe(0);
      console.log('Synthesized upload parent capture', JSON.stringify({ ...capture, sourceRequests: requests }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('refuses a duplicate declared business key in the same source statement', async () => {
    await endpoint.connection.run("INSERT INTO s1.imports.orders_version_1 VALUES ('owned-duplicate',1,10)");
    const cursor = endpoint.sourceRequests.length;
    let refusal: Error | undefined;

    try {
      try {
        await endpoint.execute(packet.query, 'reader');
      } catch (error) {
        refusal = error as Error;
      }
      expect(refusal?.message).toContain('lookup_rhs_not_unique:orders.id');
      expect(endpoint.sourceRequests.slice(cursor)).toHaveLength(1);
      expect(endpoint.sourceRequests[cursor]).toMatchObject({ principal: 'reader', rowCount: 0, completed: false });
      console.log(
        'Synthesized upload same-statement cardinality capture',
        JSON.stringify({
          caseId: packet.caseId,
          error: refusal!.message,
          sourceRequests: endpoint.sourceRequests.slice(cursor)
        })
      );
    } finally {
      await endpoint.connection.run("DELETE FROM s1.imports.orders_version_1 WHERE _dlt_id = 'owned-duplicate'");
    }
  });
});

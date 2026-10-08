import { execFile, fork } from 'child_process';
import { join } from 'path';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { createRequire } from 'module';
import { PostgresDriver } from '@cubejs-backend/postgres-driver';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

const loadApplicationRuntime = createRequire(__filename);

// Independent source-population oracle; never built from the candidate plan.
const countReferenceSql = `
  WITH selected_customers AS MATERIALIZED (
    SELECT c_custkey FROM public.customer WHERE c_custkey BETWEEN 1 AND 25
  ), selected_orders AS MATERIALIZED (
    SELECT o.o_orderkey FROM public.orders o JOIN selected_customers c ON c.c_custkey = o.o_custkey
  )
  SELECT (SELECT count(*) FROM selected_customers) AS customer_count,
         (SELECT count(*) FROM selected_orders) AS order_count,
         (SELECT count(*) FROM public.lineitem l JOIN selected_orders o ON o.o_orderkey = l.l_orderkey) AS line_count`;

// Aggregate the two facts independently at the requested grain. The companion
// raw-join mutation repeats order prices and must disagree with these rows.
const groupedReferenceSql = `
  WITH order_state AS MATERIALIZED (
    SELECT o_custkey, date_trunc('month', o_orderdate)::date AS month,
           sum(o_totalprice)::numeric(38,2) AS order_total
    FROM public.orders WHERE o_custkey BETWEEN 1 AND 25 AND (o_orderstatus <> 'F' OR o_orderstatus IS NULL)
    GROUP BY o_custkey, date_trunc('month', o_orderdate)::date
  ), line_state AS MATERIALIZED (
    SELECT o.o_custkey, date_trunc('month', o.o_orderdate)::date AS month,
           sum(l.l_extendedprice * (1 - l.l_discount))::numeric(38,4) AS line_amount
    FROM public.orders o JOIN public.lineitem l ON l.l_orderkey = o.o_orderkey
    WHERE o.o_custkey BETWEEN 1 AND 25 AND (o.o_orderstatus <> 'F' OR o.o_orderstatus IS NULL)
    GROUP BY o.o_custkey, date_trunc('month', o.o_orderdate)::date
  )
  SELECT o.o_custkey::text AS customer_id, o.month::text AS month,
         o.order_total::text AS order_total, l.line_amount::text AS line_amount
  FROM order_state o LEFT JOIN line_state l ON l.o_custkey = o.o_custkey AND l.month = o.month
  ORDER BY o.o_custkey, o.month`;
const groupedMutantSql = `
  SELECT o.o_custkey::text AS customer_id, date_trunc('month', o.o_orderdate)::date::text AS month,
         sum(o.o_totalprice)::numeric(38,2)::text AS order_total,
         sum(l.l_extendedprice * (1 - l.l_discount))::numeric(38,4)::text AS line_amount
  FROM public.orders o LEFT JOIN public.lineitem l ON l.l_orderkey = o.o_orderkey
  WHERE o.o_custkey BETWEEN 1 AND 25 AND (o.o_orderstatus <> 'F' OR o.o_orderstatus IS NULL)
  GROUP BY o.o_custkey, date_trunc('month', o.o_orderdate)::date
  ORDER BY o.o_custkey, date_trunc('month', o.o_orderdate)::date`;

async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([promise, new Promise<never>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

type FixtureBinding = { alias: string; kind: 'live'; dataSourceId: string };
type NodeReady = { type: 'ready'; endpoint: string; bindings: FixtureBinding[]; applicationName: string };
type NodeClosed = {
  type: 'closed';
  resolved: Array<{ alias: string; dataSourceId: string }>;
  operations: Array<{ method: string; path: string; accept?: string }>;
  state: { activeQueries: number; queuedQueries: number; sessions: number; parked: number };
  admission: number;
  runtime: { duckdbLibraries: string[]; baselineRssBytes?: number; sampledPeakRssBytes?: number; memorySampleIntervalMs?: number };
};

async function startFleetNode(applicationRoot: string) {
  const container = process.env.QUERYRAILS_NEON_FLEET_CONTAINER;
  if (container) {
    // The existing native packet can consume its same IPC fixture in a frozen
    // Linux image. Only the explicitly labelled, owned local container may be
    // stopped; no remote endpoint or running application is accepted here.
    if (!/^queryrails-neon-owned-[a-z0-9-]{1,32}$/.test(container)) throw new Error('Invalid owned Linux fixture name');
    const docker = (...args: string[]) => promisify(execFile)('docker', ['--context', 'desktop-linux', ...args], {
      timeout: 30000, maxBuffer: 1024 * 1024
    });
    const identity = await docker('inspect', '--format', '{{index .Config.Labels "queryrails.task"}}|{{index .Config.Labels "queryrails.fixture"}}|{{.State.Running}}', container);
    if (identity.stdout.trim() !== 'query-operations-recovery|neon-federation|true') throw new Error('Unowned or inactive Linux fixture');
    const records = async () => (await docker('logs', container)).stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as NodeReady | NodeClosed);
    const ready = (await records()).find((record): record is NodeReady => record.type === 'ready');
    if (!ready) throw new Error('Owned Linux fixture is not ready');
    const port = (await docker('port', container, '4700/tcp')).stdout.trim();
    if (!/^127\.0\.0\.1:\d+$/.test(port)) throw new Error('The owned fixture requires a loopback publication');
    return { ...ready,
      endpoint: `http://${port}`,
      stop: async () => {
        await docker('stop', '--time', '10', container);
        const closed = (await records()).find((record): record is NodeClosed => record.type === 'closed');
        if (!closed) throw new Error('Missing Linux fixture cleanup evidence');
        return closed;
      } };
  }
  // A controlled test may preload its pinned private runtime into this owned
  // child. The ordinary fixture continues to use the installed runtime.
  const bootstrap = process.env.QUERYRAILS_NEON_FLEET_FIXTURE_BOOTSTRAP;
  if (bootstrap && !existsSync(bootstrap)) throw new Error('Missing owned Fleet fixture bootstrap');
  const child = fork(join(applicationRoot, 'apps/ducklake/src/fleet/neon-federation.fixture.ts'), [], {
    cwd: join(applicationRoot, 'apps/ducklake'),
    execPath: process.execPath,
    execArgv: [...(bootstrap ? ['--require', bootstrap] : []), '--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: process.env
  });
  let resolveReady: (value: NodeReady) => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<NodeReady>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let closed: NodeClosed | undefined;
  child.on('message', (message: NodeReady | NodeClosed | { type: 'failed'; errorType: string }) => {
    if (message.type === 'ready') resolveReady(message);
    else if (message.type === 'closed') closed = message;
    else rejectReady(new Error(`Owned Fleet fixture setup failed (${message.errorType})`));
  });
  const exited = new Promise<void>(resolve => {
    child.once('exit', (code, signal) => { rejectReady(new Error(`Owned Fleet fixture exited (${code ?? signal})`)); resolve(); });
    child.once('error', error => { rejectReady(error); resolve(); });
  });
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ type: 'stop' });
      else child.kill('SIGTERM');
    }

    try { await bounded(exited, 10000, 'Owned Fleet fixture cleanup'); } catch (error) {
      child.kill('SIGKILL');
      await bounded(exited, 5000, 'Owned Fleet fixture exit');
      throw error;
    }
    return closed;
  }

  try { return { ...(await bounded(ready, 30000, 'Owned Fleet fixture startup')), stop }; } catch (error) {
    await stop();
    throw error;
  }
}

describe('Compiler-authored defined blends on existing Neon through PostgreSQL', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  let source: PostgresDriver;
  let packet: { caseId?: 'TPCH-001' | 'TPCH-002' | 'TPCH-003'; query: string; sql: string; modelSource: string; fixtureSha256: string; compilerRevision: number; inputs: Array<{ sql: string }>; residualSql: string };
  let expected: Array<Array<string | null>>;
  let referenceSql: string;
  let mutantRows: Array<Array<string | null>> | undefined;
  let expectedSchema: Array<{ name: string; column_type: string }>;
  let sourceAliases: string[];
  beforeAll(async () => {
    const packetPath = process.env.QUERYRAILS_NEON_BLEND_PACKET_PATH;
    const sourceUrl = process.env.DATABASES_DIRECT_URL;
    if (!packetPath || !sourceUrl) throw new Error('Compile the candidate and load the existing dataset connection before capture');
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
    const identity = await source.query<{ database: string; read_only: string }>('SELECT current_database() AS database, current_setting(\'default_transaction_read_only\') AS read_only', []);
    expect(identity).toEqual([{ database: 'tpc_h', read_only: 'on' }]);
    const keys = await source.query<{ table_name: string; column_name: string; data_type: string }>(`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND ((table_name = 'customer' AND column_name = 'c_custkey')
        OR (table_name = 'orders' AND column_name IN ('o_orderkey', 'o_custkey'))
        OR (table_name = 'lineitem' AND column_name = 'l_orderkey'))
      ORDER BY table_name, column_name`, []);
    expect(keys).toEqual([
      { table_name: 'customer', column_name: 'c_custkey', data_type: 'bigint' },
      { table_name: 'lineitem', column_name: 'l_orderkey', data_type: 'bigint' },
      { table_name: 'orders', column_name: 'o_custkey', data_type: 'bigint' },
      { table_name: 'orders', column_name: 'o_orderkey', data_type: 'bigint' }
    ]);
    // The case selects an independently authored reference, never packet SQL.
    // No returned page or output LIMIT defines either fact's population.
    if (packet.caseId === 'TPCH-002' || packet.caseId === 'TPCH-003') {
      referenceSql = groupedReferenceSql;
      const names = ['customer_id', 'month', 'order_total', 'line_amount'];
      const truth = await source.query<Record<string, string | null>>(referenceSql, []);
      expected = truth.map(row => names.map(name => row[name]));
      const mutant = await source.query<Record<string, string | null>>(groupedMutantSql, []);
      mutantRows = mutant.map(row => names.map(name => row[name]));
      expect(expected).toHaveLength(133);
      expect(mutantRows).not.toEqual(expected);
      expectedSchema = names.map((name, index) => ({ name,
        column_type: [packet.caseId === 'TPCH-003' ? 'Int64' : 'Decimal(38, 0)', 'Date32', 'Decimal(38, 2)', 'Decimal(38, 4)'][index] }));
      sourceAliases = ['s1', 's2'];
    } else {
      if (packet.caseId && packet.caseId !== 'TPCH-001') throw new Error('Unknown independent Neon case');
      referenceSql = countReferenceSql;
      const truth = await source.query<{ customer_count: string; order_count: string; line_count: string }>(referenceSql, []);
      expected = truth.map(row => [row.customer_count, row.order_count, row.line_count]);
      expect(expected).toEqual([['25', '244', '982']]);
      expectedSchema = ['customers.count', 'orders.count', 'lineitems.count'].map(name => ({ name, column_type: 'Int64' }));
      sourceAliases = ['s0', 's1', 's2'];
    }
    console.log('Existing Neon independent blend reference capture', JSON.stringify({
      caseId: packet.caseId ?? 'TPCH-001',
      fixtureSha256: packet.fixtureSha256,
      referenceSql,
      independentExpected: expected,
      mutantRows,
      evidenceBoundary: 'Independently authored read-only PostgreSQL truth for the complete selected population. No candidate or source-planner SQL defines these expected rows.'
    }));
    endpoint = await startSemanticSqlEndpoint({
      model: () => packet.modelSource,
      setupSQL: '',
      sourceDriver: source,
      streamMode: true,
      grants: new Map([['reader', ['reader']]])
    });
    if (packet.caseId === 'TPCH-003') {
      const response = await fetch(endpoint.url.replace(/\/cubesql$/, '/meta?extended'), {
        headers: { Authorization: 'reader' }, signal: AbortSignal.timeout(30000)
      });
      expect(response.status).toBe(200);
      const meta = await response.json() as { cubes: Array<{ name: string; dimensions: Array<{ name: string }> }> };
      expect(meta.cubes.map(cube => cube.name).sort()).toEqual(['customers', 'lineitems', 'orders']);
      expect(meta.cubes.flatMap(cube => cube.dimensions).map(dimension => dimension.name).some(name => name.endsWith('.row_id'))).toBe(false);
      expect(packet.inputs.every(input => !input.sql.includes('row_id'))).toBe(true);
      console.log('Existing Neon private identity metadata capture', JSON.stringify({
        caseId: packet.caseId,
        fixtureSha256: packet.fixtureSha256,
        dimensions: meta.cubes.flatMap(cube => cube.dimensions).map(dimension => dimension.name),
        inputs: packet.inputs,
        evidenceBoundary: 'Modeled native entity keys remain private in actual reader metadata and grouped Cube input projections. This is not a published upload-version or application grant proof.'
      }));
    }
  });
  afterAll(async () => { if (endpoint) await endpoint.stop(); else await source?.release(); });

  test('preserves exact ordered results and actual PostgreSQL source reads', async () => {
    const cursor = endpoint.sourceRequests.length;
    const started = performance.now();
    let actual: Awaited<ReturnType<typeof endpoint.execute>> | undefined;
    let executionError: unknown;

    try { actual = await endpoint.execute(packet.query, 'reader'); } catch (error) { executionError = error; }
    const sourceRequests = endpoint.sourceRequests.slice(cursor);
    console.log('Existing Neon joined-count native capture', JSON.stringify({
      caseId: packet.caseId ?? 'TPCH-001',
      fixtureSha256: packet.fixtureSha256,
      compilerRevision: packet.compilerRevision,
      sqlSha256: createHash('sha256').update(packet.sql).digest('hex'),
      query: packet.query,
      schema: actual?.messages.find(message => message.schema)?.schema,
      rows: actual?.rows,
      executionErrorType: (executionError as { name?: string } | undefined)?.name,
      referenceSql,
      independentExpected: expected,
      mutantRows,
      sourceRequests,
      wallTimeMs: performance.now() - started,
      evidenceBoundary: 'Private native PostgreSQL-source correctness; application authority, both Fleet lanes and released runtimes remain unqualified.'
    }));
    if (executionError) throw executionError;
    expect(actual?.rows).toEqual(expected);
    expect(actual?.messages.find(message => message.schema)?.schema).toEqual(expectedSchema);
    expect(sourceRequests.length).toBeGreaterThan(0);
    expect(sourceRequests.every(request => request.completed && request.principal === 'reader')).toBe(true);
  });

  test('feeds actual Cube operands through the application parent and signed Fleet wire', async () => {
    const applicationRoot = process.env.QUERYRAILS_APPLICATION_ROOT;
    if (!applicationRoot) throw new Error('The application root is required for the controlled Cube/Fleet comparison');
    const cursor = endpoint.sourceRequests.length;
    const directory = mkdtempSync(join(tmpdir(), 'qr-neon-parent-wire-'));
    const capturePath = join(directory, 'capture.json');
    let capture;

    try {
      await promisify(execFile)(process.execPath, [
        join(applicationRoot, 'apps/api/node_modules/vitest/vitest.mjs'), 'run',
        'src/test/semantic-parity-integration/neon-blend-fleet-wire.integration.test.ts'
      ], {
        cwd: join(applicationRoot, 'apps/api'),
        timeout: 60000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          QUERYRAILS_NEON_CUBE_URL: endpoint.url.replace(/\/cubesql$/, ''),
          QUERYRAILS_NEON_EXPECTED_ROWS: JSON.stringify(expected),
          QUERYRAILS_NEON_EXPECTED_SCHEMA: JSON.stringify(expectedSchema),
          QUERYRAILS_NEON_WIRE_CAPTURE_PATH: capturePath
        }
      });
      capture = JSON.parse(readFileSync(capturePath, 'utf8'));
    } finally { rmSync(directory, { recursive: true, force: true }); }
    const requests = endpoint.sourceRequests.slice(cursor);
    expect(requests).toHaveLength(1);
    expect(requests[0].completed).toBe(true);
    expect(requests[0].principal).toBe('reader');
    expect(requests[0].rowCount).toBe(expected.length);
    console.log('Existing Neon Cube/Fleet wire capture', JSON.stringify({ ...capture, sourceRequests: requests }));
  });

  test('refuses an unknown fixture principal before any PostgreSQL source dispatch', async () => {
    const cursor = endpoint.sourceRequests.length;
    const response = await endpoint.request(packet.query, 'ungranted');
    expect(response.status).toBe(403);
    await response.arrayBuffer();
    expect(endpoint.sourceRequests).toHaveLength(cursor);
  });

  test('preserves the same joined population below Cube through three distinct Fleet bindings', async () => {
    const applicationRoot = process.env.QUERYRAILS_APPLICATION_ROOT;
    if (!applicationRoot) throw new Error('The application root is required for the controlled federation comparison');
    await endpoint.stop();
    const node = await startFleetNode(applicationRoot);
    // Use the built production adapter and shared token minter; no source
    // credentials leave the owned Fleet child or enter its HTTP requests.
    const { FleetDriver, createFleetTokenProvider } = loadApplicationRuntime(join(applicationRoot, 'packages/fleet-cubejs-driver/dist/cjs/index.cjs'));
    const driver = new FleetDriver({ mode: 'http',
      endpoint: node.endpoint,
      tokenProvider: createFleetTokenProvider({ secret: 'fixture-only-neon-federation-secret' }),
      attribution: { tenantId: 'fixture-tenant', userId: 'reader' },
      sessionSpec: { scopeSetHash: createHash('sha256').update(JSON.stringify(node.bindings)).digest('hex'),
        scopes: node.bindings,
        timezone: 'UTC',
        tenantId: 'fixture-tenant',
        blendId: 'neon-tpch-defined-fixture',
        budget: { deadlineMs: 30000, memoryLimit: '2GB', threads: 1, maxConcurrentQueries: 1 } }
    });
    const modelSource = packet.modelSource.replace('public.customer', 's0.public.customer')
      .replace('public.orders', 's1.public.orders').replace('public.lineitem', 's2.public.lineitem');
    let actual: Awaited<ReturnType<typeof endpoint.execute>> | undefined;
    let nodeCapture: NodeClosed | undefined;
    let executionError: unknown;
    const monitorUrl = new URL(process.env.DATABASES_DIRECT_URL!);
    monitorUrl.pathname = '/tpc_h';
    const monitor = new PostgresDriver({ connectionString: monitorUrl.toString(),
      readOnly: true,
      maxPoolSize: 1,
      options: '-c default_transaction_read_only=on -c statement_timeout=30000',
      executionTimeout: 30 });
    const sourceActivity: Array<{ elapsedMs: number; reads: unknown[] }> = [];
    let observing = false;
    let activeObservation = Promise.resolve();
    const started = performance.now();
    const observer = setInterval(() => {
      if (observing) return;
      observing = true;
      activeObservation = monitor.query(`SELECT state, wait_event_type, wait_event, query
        FROM pg_stat_activity WHERE application_name = $1 ORDER BY pid`, [node.applicationName])
        .then(reads => { sourceActivity.push({ elapsedMs: performance.now() - started, reads }); })
        .finally(() => { observing = false; });
      activeObservation.catch(() => { /* A monitoring failure is not candidate evidence. */ });
    }, 2000);

    try {
      endpoint = await startSemanticSqlEndpoint({ model: () => modelSource,
        setupSQL: '',
        sourceDriver: driver,
        sourceDialect: 'duckdb',
        streamMode: true,
        grants: new Map([['reader', ['reader']]]) });
      actual = await endpoint.execute(packet.query, 'reader');
    } catch (error) {
      executionError = error;
    } finally {
      clearInterval(observer);
      await activeObservation.catch(() => undefined);

      try {
        try { await endpoint.stop(); await driver.release(); } finally { nodeCapture = await node.stop(); }
      } finally { await monitor.release(); }
    }
    const { sourceRequests } = endpoint;
    console.log('Existing Neon Cube/Fleet federation capture', JSON.stringify({
      caseId: packet.caseId ?? 'TPCH-001',
      fixtureSha256: packet.fixtureSha256,
      compilerRevision: packet.compilerRevision,
      sqlSha256: createHash('sha256').update(packet.sql).digest('hex'),
      query: packet.query,
      modelSource,
      referenceSql,
      independentExpected: expected,
      mutantRows,
      rows: actual?.rows,
      schema: actual?.messages.find(message => message.schema)?.schema,
      sourceRequests,
      nodeCapture,
      sourceActivity,
      wallTimeMs: performance.now() - started,
      executionErrorType: (executionError as { name?: string } | undefined)?.name,
      evidenceBoundary: 'Private below-Cube production Fleet wire with separate logical bindings on one existing database; application authority, released runtime and public routing remain unqualified.'
    }));
    expect(nodeCapture?.state).toMatchObject({ sessions: 0, parked: 0, activeQueries: 0, queuedQueries: 0 });
    expect(nodeCapture?.admission).toBe(0);
    if (executionError) throw executionError;
    expect(actual?.rows).toEqual(expected);
    expect(actual?.messages.find(message => message.schema)?.schema).toEqual(expectedSchema);
    expect(sourceRequests).toHaveLength(1);
    expect(sourceRequests[0]).toMatchObject({ principal: 'reader', rowCount: expected.length, completed: true, streamed: true });

    for (const alias of sourceAliases) expect(sourceRequests[0].query).toContain(`${alias}.public.`);
    expect(nodeCapture?.resolved).toEqual(node.bindings.map(({ alias, dataSourceId }) => ({ alias, dataSourceId })));
    expect(nodeCapture?.operations.some(operation => operation.accept === 'application/vnd.apache.arrow.stream')).toBe(true);
  });
});

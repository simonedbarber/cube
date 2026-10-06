import { execFile } from 'child_process';
import { promisify } from 'util';

const runNode = promisify(execFile);
const nativePath = require.resolve('../js');

// A retained SQL handle must not retain stopped services or their referenced
// Neon channels. Exercise actual Node exit in a child: Jest's own teardown and
// forced exit cannot establish this contract. execFile kills only this child
// on timeout, so a broken native lifetime cannot hang the entire test run.
const child = String.raw`
const assert = require('assert/strict');
const { Writable } = require('stream');
const { createServer } = require('net');
const { createRequire } = require('module');
const { Client } = createRequire(process.argv[1])('pg');
const native = require(process.argv[1]);
const mode = process.argv[2];
const shutdownMode = mode === 'escalation' ? 'fast' : mode;
native.setupLogger(() => {}, 'warn');
if (mode === 'logger') {
  console.log('logger-ready');
} else {
  const methods = {
    contextToApiScopes: async () => [],
    checkAuth: async () => ({}),
    checkSqlAuth: async () => ({ password: null, superuser: false, securityContext: {}, skipPasswordCheck: true }),
    meta: async () => ({ cubes: [], compilerId: '90286a76-4ec4-4ab8-9da1-aaf74d387ac5' }),
    stream: async () => ({ error: 'Unused lifecycle fixture source' }),
    sqlApiLoad: async () => ({ error: 'Unused lifecycle fixture source' }),
    sql: async () => ({ error: 'Unused lifecycle fixture source' }),
    sqlGenerators: async () => ({ memberToDataSource: {}, dataSourceToSqlGenerator: {} }),
    logLoadEvent: () => {},
    canSwitchUserForSession: () => false,
  };
  const sink = () => new Writable({ write(chunk, encoding, done) { done(); } });
  (async () => {
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const first = await native.registerInterface(methods);
    const second = await native.registerInterface({ ...methods, pgPort: port });
    // Keep both JS boxes reachable after shutdown, without GC or resetLogger.
    globalThis.retainedInterfaces = [first, second];
    const firstChunks = [];
    const firstStream = new Writable({
      write(chunk, encoding, done) { firstChunks.push(chunk.toString()); done(); },
    });
    globalThis.retainedStreams = [firstStream];
    await native.execSql(first, 'SELECT 7 AS answer', firstStream);
    const firstRows = firstChunks.join('').split('\n').filter(Boolean)
      .flatMap(line => JSON.parse(line).data || []);
    assert.equal(Number(firstRows[0][0]), 7);
    assert.equal(firstStream.writableFinished, true);
    await native.shutdownInterface(first, shutdownMode);
    await assert.rejects(native.execSql(first, 'SELECT 1', sink()), /SQL interface has been shut down/);
    await assert.rejects(native.sql4sql(first, 'SELECT 1', false), /SQL interface has been shut down/);
    await assert.rejects(native.rest4sql(first, 'SELECT 1'), /SQL interface has been shut down/);
    await native.shutdownInterface(first, shutdownMode);
    // Closing one interface must not close the other's callback channels.
    let logged;
    const observed = new Promise(resolve => { logged = resolve; });
    native.setupLogger(({ event }) => {
      if (event.type === 'Cube SQL Error') logged();
    }, 'trace');
    const deadline = setTimeout(() => {
      console.error('Native error log callback was not delivered');
      process.exitCode = 1;
      logged();
    }, 5000);
    let client;
    try {
      // Native listener registration is asynchronous. Retry only connection
      // refusal until this task-owned listener is ready.
      for (let attempt = 0; ; attempt++) {
        client = new Client({ host: '127.0.0.1', port, user: 'lifecycle', connectionTimeoutMillis: 1000 });
        try { await client.connect(); break; } catch (error) {
          await client.end();
          if (error.code !== 'ECONNREFUSED' || attempt >= 19) throw error;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      // Populate both enabled rewrite caches and repeat the query while the
      // interface is live. Stopped handles and listeners alone must not leave
      // cached analysis retaining the entire service graph.
      for (let iteration = 0; iteration < 2; iteration++) {
        const result = await client.query('SELECT 42 AS answer');
        assert.equal(Number(result.rows[0].answer), 42);
      }
      await assert.rejects(client.query('SELECT ('));
      await observed;
      if (mode === 'escalation') {
        client.on('error', () => {});
        let settled = false;
        const smart = native.shutdownInterface(second, 'smart').then(() => { settled = true; });
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(settled, false, 'Smart shutdown must wait for the connected client');
        await assert.rejects(native.execSql(second, 'SELECT 1', sink()), /SQL interface has been shut down/);
        await native.shutdownInterface(second, 'fast');
        await smart;
      }
    } finally {
      clearTimeout(deadline);
      await client?.end();
    }
    await native.shutdownInterface(second, shutdownMode);
    console.log('shutdown-complete:' + mode);
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
`;

describe('Native process lifetime', () => {
  jest.setTimeout(30000);

  test('a process-wide logger permits natural Node exit', async () => {
    const result = await runNode(process.execPath, ['-e', child, nativePath, 'logger'], { timeout: 10000 });
    expect(result.stdout).toContain('logger-ready');
    expect(result.stderr).toBe('');
  });

  test.each(['fast', 'semifast', 'smart', 'escalation'])('%s shutdown releases retained handles and preserves another interface', async mode => {
    const result = await runNode(process.execPath, ['-e', child, nativePath, mode], {
      timeout: 10000,
      env: { ...process.env, CUBESQL_REWRITE_CACHE: 'true', CUBESQL_PARAMETERIZED_REWRITE_CACHE: 'true' },
    });
    expect(result.stdout).toContain(`shutdown-complete:${mode}`);
    expect(result.stderr).toBe('');
  });
});

import { createServer } from 'net';
import { describe, expect, jest, test } from '@jest/globals';
import { PassThrough, Readable, Writable } from 'stream';
import { Client, Query } from 'pg';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { QueryKey } from '@cubejs-backend/base-driver';
import { PostgresDriver, PgClient } from '@cubejs-backend/postgres-driver';
import { QueryCache } from '@cubejs-backend/query-orchestrator';
import * as native from '@cubejs-backend/native';
import metaFixture from '@cubejs-backend/native/dist/test/meta';

const SQL = 'SELECT customer_gender FROM KibanaSampleDataEcommerce ORDER BY customer_gender LIMIT 60001';
const SOURCE_NAME = 'queryrails-native-sql-cancellation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Native cancellation did not finish within five seconds')), 5000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor<T>(sample: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  while (true) {
    const result = await sample();
    if (matches(result)) return result;
    if (Date.now() >= deadline) throw new Error(`Native cancellation observation timed out: ${JSON.stringify(result)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function methods(sqlApiLoad: native.SQLInterfaceOptions['sqlApiLoad']) {
  return {
    sqlApiLoad,
    meta: async () => metaFixture,
    contextToApiScopes: async () => ['data', 'meta', 'graphql'],
    checkAuth: async () => ({ securityContext: { fixture: true } }),
    checkSqlAuth: async () => ({ password: 'test', superuser: false, securityContext: { fixture: true } }),
    sql: async () => { throw new Error('Unexpected SQL generation in cancellation fixture'); },
    stream: async () => { throw new Error('Unexpected legacy stream in cancellation fixture'); },
    sqlGenerators: async () => ({ cubeNameToDataSource: {}, memberToDataSource: {}, dataSourceToSqlGenerator: {} }),
    canSwitchUserForSession: () => false,
    logLoadEvent: () => undefined,
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  return address.port;
}

describe('Native SQL stream cancellation', () => {
  jest.setTimeout(60000);

  test('HTTP output close destroys a source that has not produced a first chunk', async () => {
    const source = new PassThrough({ objectMode: true });
    const issued = deferred<void>();
    const instance = await native.registerInterface(methods(async ({ streaming }) => {
      expect(streaming).toBe(true);
      issued.resolve();
      return { stream: source };
    }));
    const output = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    const result = native.execSql(instance, SQL, output);

    try {
      await within(issued.promise);
      expect(source.destroyed).toBe(false);
      output.destroy();
      await within(result);
      await waitFor(async () => source.destroyed, value => value);
      expect(source.readableLength).toBe(0);
    } finally {
      output.destroy();
      source.destroy();
      await within(result);
      await native.shutdownInterface(instance, 'fast');
    }
  });

  test('HTTP close during callback setup destroys the late source without starting it', async () => {
    const issued = deferred<void>();
    const ready = deferred<void>();
    let reads = 0;
    const source = new Readable({ objectMode: true, read: () => { reads++; } });
    const instance = await native.registerInterface(methods(async ({ streaming }) => {
      expect(streaming).toBe(true);
      issued.resolve();
      await ready.promise;
      return { stream: source };
    }));
    const output = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    const result = native.execSql(instance, SQL, output);

    try {
      await within(issued.promise);
      output.destroy();
      await within(result);
      ready.resolve();
      await waitFor(async () => source.destroyed, value => value);
      expect(reads).toBe(0);
    } finally {
      ready.resolve();
      output.destroy();
      source.destroy();
      await within(result);
      await native.shutdownInterface(instance, 'fast');
    }
  });

  describe('PG client EOF reaches the PostgreSQL source', () => {
    let container: StartedTestContainer | undefined;
    let oracle: PgClient;
    let driver: PostgresDriver;

    beforeAll(async () => {
      container = await new GenericContainer('postgres:16.6-alpine')
        .withLabels({ 'queryrails.fixture': 'native-sql-cancellation' })
        .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'test' })
        .withExposedPorts(5432)
        .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
        .start();
      const config = {
        host: container.getHost(),
        port: container.getMappedPort(5432),
        user: 'test',
        password: 'test',
        database: 'test',
      };
      oracle = new PgClient(config);
      await oracle.connect();
      driver = new PostgresDriver({ ...config, maxPoolSize: 1, application_name: SOURCE_NAME });
      await oracle.query(`CREATE TABLE native_cancellation_rows AS
        SELECT 'row' || lpad(id::text, 3, '0') AS category FROM generate_series(1, 200) id`);
    });

    afterAll(async () => {
      try {
        await driver?.release();
        await oracle?.end();
      } finally {
        await container?.stop();
      }
    });

    test('cancels observed source work before lock release, admits no rows, and recovers all 200', async () => {
      let requests = 0;
      const sourceCompleted = deferred<void>();
      const sourceSQL = `/* qr-native-pg-eof */ SELECT category AS "KibanaSampleDataEcommerce.customer_gender"
        FROM native_cancellation_rows ORDER BY category`;
      const sourceMethods = methods(async ({ streaming, request }) => {
        expect(streaming).toBe(true);
        requests++;
        const key: QueryKey = [sourceSQL, []];
        key.persistent = true;
        const queue = QueryCache.createQueue(`native-pg-eof-${request.id}`, () => driver, () => [], {
          cacheAndQueueDriver: 'memory',
          logger: message => {
            if (message === 'Error while querying') sourceCompleted.resolve();
          },
        });
        const stream = await queue.executeInQueue('stream', key, {
          queryKey: key, query: sourceSQL, values: [], requestId: request.id,
        }, 0, { requestId: request.id });
        return { stream };
      });
      const port = await freePort();
      const instance = await native.registerInterface({ ...sourceMethods, pgPort: port });
      const client = new Client({ host: '127.0.0.1', port, user: 'test', password: 'test', database: 'test', ssl: false });
      const recoveredClient = new Client({ host: '127.0.0.1', port, user: 'test', password: 'test', database: 'test', ssl: false });
      let admitted = 0;
      let queryIssued = false;
      let queryError: unknown;
      const query = new Query(SQL);
      query.on('row', () => { admitted++; });
      const outcome = new Promise<unknown>(resolve => {
        query.once('error', error => { queryError = error; resolve(error); });
        query.once('end', resolve);
      });
      const activity = async () => {
        await oracle.query('SELECT pg_stat_clear_snapshot()');
        return (await oracle.query<{ pid: number; state: string; wait_event: string | null; query: string }>(
          'SELECT pid, state, wait_event, query FROM pg_stat_activity WHERE application_name = $1', [SOURCE_NAME]
        )).rows;
      };

      try {
        await client.connect();
        await oracle.query('BEGIN');
        await oracle.query('LOCK TABLE native_cancellation_rows IN ACCESS EXCLUSIVE MODE');
        queryIssued = true;
        client.query(query);
        const observed = await waitFor(async () => {
          if (queryError) throw queryError;
          return activity();
        }, rows => rows.some(row => row.state === 'active' && row.wait_event === 'relation' && row.query.startsWith('/* qr-native-pg-eof */')));
        const cancelledAt = Date.now();
        await within(client.end());
        await within(outcome);
        const remaining = await waitFor(activity, rows => rows.every(row => !observed.some(old => old.pid === row.pid)));
        await within(sourceCompleted.promise);
        expect(remaining).toEqual([]);
        expect(admitted).toBe(0);
        console.log('native PG EOF source cancellation', { observed, remaining, admitted, elapsedMs: Date.now() - cancelledAt });
        await oracle.query('ROLLBACK');
        const expected = (await oracle.query('SELECT category AS customer_gender FROM native_cancellation_rows ORDER BY category')).rows;
        await recoveredClient.connect();
        const recovered = await within(recoveredClient.query(SQL));
        expect(recovered.rows).toEqual(expected);
        expect(recovered.rowCount).toBe(200);
        expect(recovered.fields[0].dataTypeID).toBe(25);
        expect(requests).toBe(2);
      } finally {
        await client.end();
        await oracle.query('ROLLBACK');
        await recoveredClient.end();
        await native.shutdownInterface(instance, 'fast');
        if (queryIssued) await within(outcome);
      }
    });
  });
});

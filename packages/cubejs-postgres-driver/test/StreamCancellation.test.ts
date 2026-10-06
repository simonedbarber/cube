import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { QueryKey } from '@cubejs-backend/base-driver';
import { types as nodeTypes } from 'util';
import { PostgresDriver } from '../src/PostgresDriver';
import { PgClient } from '../src/PgClient';
import { QueryCache } from '../../cubejs-query-orchestrator/src/orchestrator/QueryCache';

const SOURCE_NAME = 'queryrails-stream-cancellation-source';

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Source cancellation did not finish within five seconds')), 5000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor<T>(sample: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  while (true) {
    const value = await sample();
    if (matches(value)) return value;
    if (Date.now() >= deadline) throw new Error(`Source observation timed out: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function queuedStream(driver: PostgresDriver, query: string, values: string[], requestId: string) {
  let complete!: () => void;
  const completed = new Promise<void>(resolve => { complete = resolve; });
  const queue = QueryCache.createQueue(`postgres-stream-cancel-${requestId}`, () => driver, () => [], {
    cacheAndQueueDriver: 'memory',
    logger: message => {
      if (message === 'Performing query completed' || message === 'Error while querying') complete();
    },
  });
  const key: QueryKey = [query, values];
  key.persistent = true;
  const start = () => queue.executeInQueue('stream', key, {
    queryKey: key, query, values, requestId,
  }, 0, { requestId });
  return { queue, start, completed };
}

describe('PostgreSQL source stream cancellation', () => {
  jest.setTimeout(60000);
  let container: StartedTestContainer | undefined;
  let oracle: PgClient;
  let driver: PostgresDriver;

  beforeAll(async () => {
    container = await new GenericContainer('postgres:16.6-alpine')
      .withLabels({ 'queryrails.fixture': 'native-stream-cancellation' })
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
    await oracle.query('CREATE TABLE cancellation_rows AS SELECT id FROM generate_series(1, 200) id');
  });

  afterAll(async () => {
    try {
      await driver?.release();
      await oracle?.end();
    } finally {
      await container?.stop();
    }
  });

  const activity = async () => {
    // The lock observer stays in a transaction; refresh statistics each sample.
    await oracle.query('SELECT pg_stat_clear_snapshot()');
    return (await oracle.query<{
      pid: number; state: string; wait_event: string | null; query: string;
    }>(`SELECT pid, state, wait_event, query FROM pg_stat_activity WHERE application_name = $1`, [SOURCE_NAME])).rows;
  };

  async function assertCompleteRecovery() {
    const expected = (await oracle.query('SELECT id FROM cancellation_rows ORDER BY id')).rows;
    const recovered = await driver.stream('SELECT id FROM cancellation_rows ORDER BY id', [], { highWaterMark: 16 });

    try {
      const rows = [];

      for await (const row of recovered.rowStream) rows.push(row);
      expect(rows).toEqual(expected);
      expect(rows).toHaveLength(200);
    } finally {
      await recovered.release?.();
    }
  }

  test('refuses a pre-aborted stream before acquiring a source connection', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled before source dispatch');
    controller.abort(reason);
    await expect(driver.stream('SELECT id FROM cancellation_rows', [], {
      highWaterMark: 16, signal: controller.signal,
    })).rejects.toBe(reason);
    expect(await activity()).toEqual([]);
  });

  test('cancels an observed table-lock wait before first fields with pool size one', async () => {
    await oracle.query('BEGIN');
    await oracle.query('LOCK TABLE cancellation_rows IN ACCESS EXCLUSIVE MODE');
    const { queue, start, completed } = queuedStream(driver,
      '/* qr-source-cancel-fields */ SELECT id FROM cancellation_rows ORDER BY id', [], 'cancel-fields');
    const target = await start();

    try {
      const observed = await waitFor(activity, rows => rows.some(row => row.state === 'active' && row.wait_event === 'relation' && row.query.startsWith('/* qr-source-cancel-fields */')));
      const cancelledAt = Date.now();
      expect(await queue.cancelQueryByRequestId('cancel-fields')).toHaveLength(1);
      await within(completed);
      const remaining = await waitFor(activity, rows => rows.every(row => !observed.some(old => old.pid === row.pid)));
      console.log('first-fields source cancellation', { observed, remaining, elapsedMs: Date.now() - cancelledAt });
      expect(remaining).toEqual([]);
      expect(target.destroyed).toBe(true);
    } finally {
      target.destroy();
      await oracle.query('ROLLBACK');
      await within(completed);
    }
    await assertCompleteRecovery();
  });

  test('cancels observed advisory-lock work after first-row delivery and recovers all rows', async () => {
    const lockKey = 927164;
    await oracle.query('SELECT pg_advisory_lock($1)', [lockKey]);
    const { queue, start, completed } = queuedStream(driver,
      `/* qr-source-cancel-after-row */ SELECT id FROM generate_series(1, 200) id
       WHERE id <= 100 OR pg_advisory_xact_lock($1::bigint)::text IS NOT NULL`, [String(lockKey)], 'cancel-after-row');
    const target = await start();
    const delivered: { id: number }[] = [];
    const consumption = (async () => {
      try {
        for await (const row of target) delivered.push(row);
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    try {
      const observed = await waitFor(activity, rows => rows.some(row => row.state === 'active' && row.wait_event === 'advisory' && row.query.startsWith('/* qr-source-cancel-after-row */')));
      expect(delivered.length).toBeGreaterThan(0);
      expect(queue.getQueryStream(target.queryKey)).toBeUndefined();
      const cancelledAt = Date.now();
      expect(await queue.cancelQueryByRequestId('cancel-after-row')).toHaveLength(1);
      await within(completed);
      const remaining = await waitFor(activity, rows => rows.every(row => !observed.some(old => old.pid === row.pid)));
      console.log('after-row source cancellation', { observed, remaining, deliveredRows: delivered.length, elapsedMs: Date.now() - cancelledAt });
      expect(remaining).toEqual([]);
      // Node stream errors can originate in a different Jest realm.
      expect(nodeTypes.isNativeError(await consumption)).toBe(true);
      expect(delivered.length).toBeLessThan(200);
    } finally {
      target.destroy();
      await oracle.query('SELECT pg_advisory_unlock($1)', [lockKey]);
      await consumption;
      await within(completed);
    }
    await assertCompleteRecovery();
  });
});

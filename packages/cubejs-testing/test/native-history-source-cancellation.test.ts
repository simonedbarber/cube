import { createServer as createHttpServer, type Server as HttpServer } from 'http';
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { createConnection, createServer as createTcpServer } from 'net';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import express from 'express';
import { Client, Query } from 'pg';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import type { QueryKey } from '@cubejs-backend/base-driver';
import { CompilerApi, type CompilerApiOptions } from '@cubejs-backend/server-core';
import { ApiGateway, CubejsHandlerError } from '@cubejs-backend/api-gateway';
import { AdapterApiMock, DataSourceStorageMock } from '@cubejs-backend/api-gateway/dist/test/mocks';
import { PostgresQuery } from '@cubejs-backend/schema-compiler/dist/src/adapter/PostgresQuery';
import { PostgresDriver, PgClient } from '@cubejs-backend/postgres-driver';
import { QueryCache, type QueryBody } from '@cubejs-backend/query-orchestrator/dist/src/orchestrator/QueryCache';
import packet from '@cubejs-backend/duckdb-driver/dist/test/semantic-sql/fixtures/window-history-canonical-sql.json';

const sourceName = 'queryrails-complete-history-cancellation';
const historyLock = 927165;
const visibleStart = Math.min(10001, packet.configuredK - 1);
const modelSource = packet.modelSource.replace("amount: { sql: 'amount',", "amount: { sql: 'history_source_amount(id, amount)',");
const largeCases = packet.cases.filter(fixture => fixture.large);
const target = largeCases.find(fixture => fixture.id === 'BOUNDARIES')!;
type SourceQuery = Required<Pick<QueryBody, 'query' | 'values' | 'requestId'>> & Pick<QueryBody, 'aliasNameToMember'> & {
  context: { securityContext: { principal: string } };
};
type SourceObservation = { query: string; values: unknown[]; principal: string; rows: number; completed: boolean; closed: boolean };
type Activity = { pid: number; state: string; wait_event: string | null; query: string };

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('History source observation did not finish within five seconds')), 5000);
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
    if (Date.now() >= deadline) throw new Error(`History source observation timed out: ${JSON.stringify(result)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  return address.port;
}

async function acceptsConnection(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Error('Owned endpoint shutdown probe timed out'));
    });
  });
}

/** Real gateway/model/planner/queue/PostgreSQL execution of frozen private
 * production history SQL. Public history admission remains withheld. */
describe('Complete extra-history source cancellation through HTTP and PG', () => {
  jest.setTimeout(60000);
  let container: StartedTestContainer | undefined;
  let oracle: PgClient;
  let driver: PostgresDriver;
  let compiler: CompilerApi;
  let gateway: ApiGateway;
  let server: HttpServer;
  let interfaceStarted = false;
  let url: string;
  let pgPort: number;
  const sourceRequests: SourceObservation[] = [];
  const sources = new Set<Transform>();
  const logs: unknown[] = [];

  const activity = async (): Promise<Activity[]> => {
    await oracle.query('SELECT pg_stat_clear_snapshot()');
    return (await oracle.query<Activity>('SELECT pid, state, wait_event, query FROM pg_stat_activity WHERE application_name = $1', [sourceName])).rows;
  };

  beforeAll(async () => {
    expect(process.env.CUBESQL_STREAM_MODE).toBe('true');
    expect(Number(process.env.CUBEJS_DB_QUERY_LIMIT)).toBe(packet.configuredK);
    expect(packet.population).toBe(packet.configuredK + 10001);
    container = await new GenericContainer('postgres:16.6-alpine')
      .withLabels({ 'queryrails.fixture': 'complete-history-cancellation' })
      .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'test' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
      .start();
    const config = { host: container.getHost(), port: container.getMappedPort(5432), user: 'test', password: 'test', database: 'test' };
    oracle = new PgClient(config);
    await oracle.connect();
    await oracle.query("SET TIME ZONE 'UTC'");
    await oracle.query(packet.setupSQL);
    // The identity-valued function blocks only pre-visible history facts.
    // Visible aggregation therefore finishes before the history branch waits.
    await oracle.query(`CREATE FUNCTION history_source_amount(id integer, amount numeric) RETURNS numeric
      LANGUAGE plpgsql VOLATILE AS $$ BEGIN
        IF id > 0 AND id < ${visibleStart} THEN PERFORM pg_advisory_xact_lock(${historyLock}); END IF;
        RETURN amount;
      END $$`);
    expect(modelSource).not.toBe(packet.modelSource);
    const population = await oracle.query('SELECT COUNT(*) AS rows FROM analytics_window_history WHERE id > 0');
    expect(Number(population.rows[0].rows)).toBe(packet.population);
    driver = new PostgresDriver({ ...config, maxPoolSize: 1, application_name: sourceName });
    compiler = new CompilerApi({ localPath: () => __dirname,
      dataSchemaFiles: async () => [{ fileName: 'complete-history-source.js', content: modelSource }] }, async () => 'postgres', {
      dialectClass: () => PostgresQuery as unknown as ReturnType<NonNullable<CompilerApiOptions['dialectClass']>>,
      allowUngroupedWithoutPrimaryKey: true,
      sqlCache: true,
      standalone: true,
      contextToGroups: context => (context.securityContext.principal === 'auditor' ? ['auditor'] : []),
    });
    class SourceAdapter extends AdapterApiMock {
      public async executeQuery(): Promise<any> {
        throw new Error('Unexpected buffered source request in streaming history fixture');
      }

      public async streamQuery(query: SourceQuery) {
        const observed: SourceObservation = { query: query.query,
          values: query.values,
          principal: query.context.securityContext.principal,
          rows: 0,
          completed: false,
          closed: false };
        sourceRequests.push(observed);
        const key: QueryKey = [query.query, query.values];
        key.persistent = true;
        const queue = QueryCache.createQueue(`history-source-${query.requestId}-${sourceRequests.length}`, () => driver, () => [], {
          cacheAndQueueDriver: 'memory', logger: (message, properties) => logs.push({ message, properties }),
        });

        try {
          const source = await queue.executeInQueue('stream', key, {
            queryKey: key,
            query: query.query,
            values: query.values,
            requestId: query.requestId,
            aliasNameToMember: query.aliasNameToMember ?? null,
          }, 0, { requestId: query.requestId });
          const counted = new Transform({ objectMode: true,
            transform: (row, _encoding, callback) => {
              observed.rows++;
              callback(null, row);
            } });
          sources.add(counted);
          counted.once('end', () => { observed.completed = true; });
          counted.once('close', () => { observed.closed = true; sources.delete(counted); });
          // The observer preserves rows and Node pipeline cancellation reaches
          // the actual QueryStream/driver owner when native closes its receiver.
          pipeline(source, counted).catch(error => counted.destroy(error));
          return counted;
        } catch (error) {
          observed.closed = true;
          throw error;
        }
      }
    }
    const source = new SourceAdapter();
    gateway = new ApiGateway('complete-history-fixture', async () => compiler, async () => source as any,
      (event, properties) => logs.push({ event, properties }), {
        standalone: true,
        dataSourceStorage: new DataSourceStorageMock(),
        refreshScheduler: {},
        basePath: '/cubejs-api',
        checkAuth: async (request, token) => {
          if (token !== 'auditor') throw new CubejsHandlerError(403, 'Forbidden', 'Unknown fixture principal');
          request.securityContext = { principal: 'auditor' };
        },
        contextToApiScopes: async () => ['data', 'meta', 'sql', 'graphql'],
      });
    pgPort = await freePort();
    await gateway.getSQLServer().init({ pgSqlPort: pgPort,
      checkSqlAuth: async () => ({ password: 'test', superuser: false, securityContext: { principal: 'auditor' }, skipPasswordCheck: true }),
      canSwitchSqlUser: () => false,
    });
    interfaceStarted = true;
    const app = express();
    app.use(express.json());
    gateway.initApp(app);
    server = createHttpServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing history HTTP fixture port');
    url = `http://127.0.0.1:${address.port}/cubejs-api/v1/cubesql`;
  });

  afterAll(async () => {
    try {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
      }
      if (server) expect(server.listening).toBe(false);
      if (interfaceStarted) {
        await within(gateway.getSQLServer().shutdown('fast'));
        await waitFor(() => acceptsConnection(pgPort), accepting => !accepting);
      }
      expect(sources.size).toBe(0);
    } finally {
      for (const source of sources) source.destroy();
      gateway?.release();
      compiler?.dispose();

      try {
        try {
          await driver?.release();
          if (oracle) await waitFor(activity, rows => rows.length === 0);
        } finally {
          await oracle?.end();
        }
      } finally {
        await container?.stop();
      }
    }
  });

  const client = () => new Client({ host: '127.0.0.1', port: pgPort, user: 'test', password: 'test', database: 'test', ssl: false });
  const http = (query: string, signal = AbortSignal.timeout(30000)) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'auditor' },
    body: JSON.stringify({ query, cache: 'no-cache', timezone: 'UTC' }),
    signal,
  });

  async function assertRecovery(transport: 'HTTP' | 'PG') {
    const recoveredClient = client();

    try {
      if (transport === 'PG') await recoveredClient.connect();

      for (const fixture of largeCases) {
        const expected = (await oracle.query(fixture.oracle)).rows.map(row => [row.region, new Date(row.bucket).toISOString(), Number(row.running)]);
        expect(expected).toEqual(fixture.expected);
        const cursor = sourceRequests.length;
        let actual: unknown[][];
        if (transport === 'PG') {
          const recovered = await within(recoveredClient.query(fixture.query));
          expect(recovered.fields.map(field => [field.name, field.dataTypeID])).toEqual([[packet.region, 25], [packet.axis, 1114], ['running', 701]]);
          actual = recovered.rows.map(row => [row[packet.region], new Date(row[packet.axis]).toISOString(), Number(row.running)]);
        } else {
          const response = await http(fixture.query);
          const body = await response.text();
          expect(response.ok).toBe(true);
          const messages = body.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
          expect(messages.some(message => message.error)).toBe(false);
          expect(messages.find(message => message.schema)?.schema).toEqual([
            { name: packet.region, column_type: 'String' }, { name: packet.axis, column_type: 'Timestamp' }, { name: 'running', column_type: 'Double' },
          ]);
          actual = messages.flatMap(message => message.data || []).map(row => [row[0], new Date(`${row[1].replace(' ', 'T')}Z`).toISOString(), Number(row[2])]);
        }
        expect(actual).toEqual(expected);
        const issued = sourceRequests.slice(cursor);
        expect(issued.every(request => request.principal === 'auditor' && request.completed && /id\s*<>\s*-8/.test(request.query))).toBe(true);
        expect(Math.max(...issued.map(request => request.rows))).toBeGreaterThanOrEqual(packet.population);
        console.log('complete history recovery', JSON.stringify({ transport,
          caseId: fixture.id,
          configuredK: packet.configuredK,
          completeHistoryGroups: packet.population,
          sourceRequests: issued,
          actual }));
      }
    } finally {
      await recoveredClient.end();
    }
  }

  test.each([
    { transport: 'HTTP', phase: 'table' }, { transport: 'PG', phase: 'table' },
    { transport: 'HTTP', phase: 'history' }, { transport: 'PG', phase: 'history' },
  ] as const)('$transport abort during $phase wait stops source work before lock release and recovers complete history', async ({ transport, phase }) => {
    const cursor = sourceRequests.length;
    const controller = new AbortController();
    const connection = client();
    let admitted = 0;
    let pending: Promise<unknown> | undefined;
    let queryError: unknown;
    let observed: Activity[] = [];
    let remaining: Activity[] = [];
    const observations: Array<{ elapsedMs: number; backends: Activity[] }> = [];
    const start = Date.now();
    await oracle.query('BEGIN');

    try {
      if (phase === 'table') await oracle.query('LOCK TABLE analytics_window_history IN ACCESS EXCLUSIVE MODE');
      else await oracle.query('SELECT pg_advisory_lock($1)', [historyLock]);
      if (transport === 'PG') {
        await connection.connect();
        const query = new Query(target.query);
        query.on('row', () => { admitted++; });
        pending = new Promise(resolve => {
          query.once('error', error => { queryError = error; resolve(error); });
          query.once('end', resolve);
        });
        connection.query(query);
      } else {
        pending = http(target.query, controller.signal).then(async response => {
          const body = await response.text();
          const messages = body.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
          admitted += messages.flatMap(message => message.data || []).length;
        }).catch(error => { queryError = error; });
      }
      const sample = async () => {
        const backends = await activity();
        observations.push({ elapsedMs: Date.now() - start, backends });
        return backends;
      };
      observed = await waitFor(async () => {
        if (queryError) throw queryError;
        return sample();
      }, rows => rows.some(row => row.state === 'active' && row.wait_event === (phase === 'table' ? 'relation' : 'advisory')));
      if (phase === 'history') {
        const issued = sourceRequests.slice(cursor);
        expect(issued.some(request => request.completed && request.rows === packet.population - visibleStart + 1)).toBe(true);
        expect(issued.some(request => !request.completed && !request.closed && /\bOVER\s*\(/i.test(request.query))).toBe(true);
      }
      if (transport === 'PG') await within(connection.end());
      else controller.abort(new Error('fixture cancellation after observed history source work'));
      await within(pending);
      remaining = await waitFor(sample, rows => rows.every(row => row.state !== 'active' && !observed.some(old => old.pid === row.pid)));
      await waitFor(async () => sourceRequests.slice(cursor).map(request => request.closed), closed => closed.length > 0 && closed.every(Boolean));
      expect(remaining).toEqual([]);
      expect(admitted).toBe(0);
      expect(queryError).toBeDefined();
      // No source lock has been released before either assertion.
    } finally {
      controller.abort(new Error('owned history fixture cleanup'));
      await connection.end();
      await oracle.query('ROLLBACK');
      if (phase === 'history') await oracle.query('SELECT pg_advisory_unlock($1)', [historyLock]);
      if (pending) await within(pending);
      console.log('complete history source cancellation', JSON.stringify({ transport,
        phase,
        configuredK: packet.configuredK,
        population: packet.population,
        emittedSql: target.query,
        observed,
        remaining,
        observations,
        sourceRequests: sourceRequests.slice(cursor),
        admitted,
        elapsedMs: Date.now() - start }));
    }
    await assertRecovery(transport);
  });
});

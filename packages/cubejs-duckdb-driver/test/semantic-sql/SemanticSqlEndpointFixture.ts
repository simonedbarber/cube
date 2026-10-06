import { createServer, type Server } from 'http';
import { Readable, Transform } from 'stream';
import { finished, pipeline } from 'stream/promises';
import express from 'express';
import { DuckDBInstance } from '@duckdb/node-api';
import { CompilerApi, type CompilerApiOptions } from '@cubejs-backend/server-core';
import { ApiGateway, CubejsHandlerError } from '@cubejs-backend/api-gateway';
import { AdapterApiMock, DataSourceStorageMock } from '@cubejs-backend/api-gateway/dist/test/mocks';
import { QueryStream } from '@cubejs-backend/query-orchestrator/dist/src/orchestrator/QueryStream';
import type { QueryBody } from '@cubejs-backend/query-orchestrator/dist/src/orchestrator/QueryCache';
import type { PostgresDriver } from '@cubejs-backend/postgres-driver';
import { PostgresQuery } from '@cubejs-backend/schema-compiler/dist/src/adapter/PostgresQuery';
import { DuckDBQuery } from '../../src/DuckDBQuery';
import { buildTransform, convertDuckDBParams, transformChunk } from '../../src/Transform';
import { DuckDBRowStream } from '../../src/RowStream';

type SourceQuery = Required<Pick<QueryBody, 'query' | 'values' | 'requestId'>> & Pick<QueryBody, 'aliasNameToMember'> & {
  context: { securityContext: { principal: string } };
};

export type SourceRequest = {
  query: string;
  values: unknown[];
  principal: string;
  rowCount: number;
  streamed: boolean;
  completed: boolean;
  columns?: string[];
};
export type EndpointSourceDriver = Pick<PostgresDriver, 'query' | 'release'> & {
  stream: (...args: Parameters<PostgresDriver['stream']>) => Promise<{
    rowStream: NodeJS.ReadableStream;
    types?: { name: string }[];
    release?: () => Promise<void>;
  }>;
};

type EndpointOptions = {
  model: () => string;
  setupSQL: string;
  grants: ReadonlyMap<string, string[]>;
  schemaVersion?: () => string | Promise<string>;
  streamMode?: boolean;
  /** Owned production driver. No setup SQL runs on this source. */
  sourceDriver?: EndpointSourceDriver;
  sourceDialect?: 'postgres' | 'duckdb';
  /** Trusted fixture projections consumed by the actual compiled policies. */
  securityContexts?: ReadonlyMap<string, Record<string, unknown>>;
  /** Owned compile callback context; query authority remains per request. */
  compileContext?: Record<string, unknown>;
};

/** Source-owned numerical HTTP fixture. Policies, parser, planner and driver
 * value/stream conversion use their actual implementations. Only orchestrator
 * scheduling/cache and application authority are outside this fixture. */
export async function startSemanticSqlEndpoint(options: EndpointOptions) {
  // Jest virtualizes process.env; changing it here does not change the Rust
  // addon's OS environment. Select native streaming before launching Jest.
  if (options.streamMode !== undefined && (process.env.CUBESQL_STREAM_MODE === 'true') !== options.streamMode) {
    throw new Error(`Launch Jest with CUBESQL_STREAM_MODE=${options.streamMode}`);
  }
  const savedEnvironment = new Map(['CUBE_JS_NATIVE_API_GATEWAY_INTERNAL']
    .map(name => [name, process.env[name]]));
  process.env.CUBE_JS_NATIVE_API_GATEWAY_INTERNAL = 'false';
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const sourceRequests: SourceRequest[] = [];
  const logs: unknown[] = [];
  const streams = new Set<Readable>();
  const sourceReleases = new Set<Promise<void>>();
  let gateway: ApiGateway | undefined;
  let compiler: CompilerApi | undefined;
  let server: Server | undefined;
  let interfaceStarted = false;
  let stopped = false;

  async function stop() {
    if (stopped) return;
    stopped = true;

    try {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server!.close(error => (error ? reject(error) : resolve())));
      }
      if (interfaceStarted) await gateway!.getSQLServer().shutdown('fast');
    } finally {
      const closing = [...streams].map(stream => {
        const closed = finished(stream);
        stream.destroy();
        return closed;
      });
      await Promise.allSettled(closing);
      await Promise.all([...sourceReleases]);
      gateway?.release();
      compiler?.dispose();
      await options.sourceDriver?.release();
      connection.closeSync();
      instance.closeSync();

      for (const [name, value] of savedEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  try {
    await connection.run("SET TimeZone = 'UTC'");
    if (options.sourceDriver && options.setupSQL.trim()) throw new Error('External read-only sources cannot receive fixture setup SQL');
    if (!options.sourceDriver) await connection.run(options.setupSQL);
    compiler = new CompilerApi({ localPath: () => __dirname,
      dataSchemaFiles: async () => [{ fileName: 'semantic-endpoint-fixture.js', content: options.model() }] }, async () => (options.sourceDriver ? (options.sourceDialect ?? 'postgres') : 'duckdb'), {
      // The existing declaration names an instance, but the actual createQuery
      // contract consumes a dialect constructor.
      dialectClass: () => (options.sourceDriver && options.sourceDialect !== 'duckdb' ? PostgresQuery : DuckDBQuery) as unknown as ReturnType<NonNullable<CompilerApiOptions['dialectClass']>>,
      allowUngroupedWithoutPrimaryKey: true,
      sqlCache: true,
      standalone: !options.compileContext,
      schemaVersion: options.schemaVersion,
      contextToGroups: context => options.grants.get(context.securityContext.principal) || [],
      ...(options.compileContext ? { compileContext: options.compileContext, allowNodeRequire: true } : {}),
    });
    class SourceAdapter extends AdapterApiMock {
      private observe(query: SourceQuery, streamed: boolean): SourceRequest {
        const observed = { query: query.query,
          values: query.values,
          principal: query.context.securityContext.principal,
          rowCount: 0,
          streamed,
          completed: false };
        sourceRequests.push(observed);
        return observed;
      }

      public async executeQuery(query: SourceQuery): Promise<any> {
        const observed = this.observe(query, false);
        if (options.sourceDriver) {
          const data = await options.sourceDriver.query<Record<string, unknown>>(query.query, query.values);
          observed.columns = data.length ? Object.keys(data[0]) : undefined;
          observed.rowCount = data.length;
          observed.completed = true;
          return { data, lastRefreshTime: new Date(), usedPreAggregations: {}, external: false };
        }
        const result = await connection.run(query.query, convertDuckDBParams(query.values));
        observed.columns = result.columnNames();
        const transform = buildTransform(result.columnNames(), result.columnTypes());
        const data: Record<string, unknown>[] = [];

        for (const chunk of await result.fetchAllChunks()) {
          for (const row of transformChunk(chunk, transform)) data.push(row);
        }
        observed.rowCount = data.length;
        observed.completed = true;
        return { data, lastRefreshTime: new Date(), usedPreAggregations: {}, external: false };
      }

      public async streamQuery(query: SourceQuery) {
        const observed = this.observe(query, true);
        if (options.sourceDriver) {
          const sourceResult = await options.sourceDriver.stream(query.query, query.values, { highWaterMark: 16 });
          if (!(sourceResult.rowStream instanceof Readable)) throw new Error('The source driver returned no owned readable stream');
          const sourceStream = sourceResult.rowStream;
          const releaseSource = sourceResult.release;
          if (!releaseSource) {
            sourceStream.destroy();
            throw new Error('The source stream returned no release owner');
          }
          observed.columns = sourceResult.types?.map(column => column.name);
          const key = String(sourceRequests.length);
          const tracked = new Map();
          const semanticStream = new QueryStream({ key, streams: tracked, aliasNameToMember: query.aliasNameToMember ?? null });
          tracked.set(key, semanticStream);
          const counter = new Transform({ objectMode: true, transform(row, encoding, callback) { observed.columns ??= Object.keys(row); observed.rowCount++; callback(null, row); } });
          streams.add(sourceStream);
          streams.add(counter);
          streams.add(semanticStream);
          sourceStream.once('end', () => { observed.completed = true; });
          sourceStream.once('close', () => streams.delete(sourceStream));
          counter.once('close', () => streams.delete(counter));
          semanticStream.once('close', () => streams.delete(semanticStream));
          // The existing query-stream owner maps aliases; the driver's release
          // waits for cursor/connection disposal on success or cancellation.
          const released = pipeline(sourceStream, counter, semanticStream)
            .catch(error => { semanticStream.destroy(error); })
            .finally(() => releaseSource());
          sourceReleases.add(released);
          released.catch(error => { semanticStream.destroy(error); });
          return semanticStream;
        }
        const streamConnection = await instance.connect();

        try {
          await streamConnection.run("SET TimeZone = 'UTC'");
          const result = await streamConnection.stream(query.query, convertDuckDBParams(query.values));
          observed.columns = result.columnNames();
          const transform = buildTransform(result.columnNames(), result.columnTypes());
          class ObservedSourceStream extends DuckDBRowStream {
            public push(chunk: unknown, encoding?: BufferEncoding): boolean {
              if (chunk !== null) observed.rowCount++;
              return super.push(chunk, encoding);
            }
          }
          const stream = new ObservedSourceStream(result, transform, () => streamConnection.closeSync(), 16);
          streams.add(stream);
          // Observe production without putting the stream into flowing mode
          // before the native caller attaches its consumer.
          stream.once('end', () => { observed.completed = true; });
          stream.once('close', () => streams.delete(stream));
          // QueryQueue's actual stream owner maps source aliases to semantic
          // members. Wrapped source SQL explicitly passes a null alias map.
          // Omitting this owner would feed raw aliases to a semantic CubeScan.
          const key = String(sourceRequests.length);
          const tracked = new Map();
          const semanticStream = new QueryStream({ key,
            streams: tracked,
            aliasNameToMember: query.aliasNameToMember ?? null });
          tracked.set(key, semanticStream);
          streams.add(semanticStream);
          semanticStream.once('close', () => streams.delete(semanticStream));
          pipeline(stream, semanticStream).catch(error => semanticStream.destroy(error));
          return semanticStream;
        } catch (error) {
          streamConnection.closeSync();
          throw error;
        }
      }
    }
    const source = new SourceAdapter();
    gateway = new ApiGateway('semantic-endpoint-fixture-secret', async () => compiler!, async () => source as any,
      (event, properties) => { logs.push({ event, properties }); }, {
        standalone: true,
        dataSourceStorage: new DataSourceStorageMock(),
        refreshScheduler: {},
        basePath: '/cubejs-api',
        checkAuth: async (authRequest, token) => {
          if (!token || !options.grants.has(token)) throw new CubejsHandlerError(403, 'Forbidden', 'Unknown or revoked fixture principal');
          authRequest.securityContext = { ...options.securityContexts?.get(token), principal: token };
        },
        contextToApiScopes: async () => ['data', 'meta', 'sql', 'graphql'],
      });
    await gateway.getSQLServer().init({
      checkSqlAuth: async () => ({ password: null, superuser: false, securityContext: {}, skipPasswordCheck: true }),
      canSwitchSqlUser: () => false,
    });
    interfaceStarted = true;
    const app = express();
    app.use(express.json());
    gateway.initApp(app);
    server = createServer(app);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing owned semantic HTTP fixture port');
    const url = `http://127.0.0.1:${address.port}/cubejs-api/v1/cubesql`;
    const request = (query: string, principal: string) => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: principal },
      body: JSON.stringify({ query, cache: 'no-cache', timezone: 'UTC' }),
      signal: AbortSignal.timeout(30000),
    });
    const execute = async (query: string, principal: string) => {
      const response = await request(query, principal);
      const body = await response.text();
      if (!response.ok) throw new Error(`Endpoint ${response.status}: ${body}; logs=${JSON.stringify(logs.slice(-4))}`);
      const messages = body.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const error = messages.find(message => message.error);
      if (error) throw new Error(`Native endpoint error: ${JSON.stringify(error)}; logs=${JSON.stringify(logs.slice(-4))}`);
      // JSON cells carry no inferred numeric/date contract. Callers assert the
      // executed schema and decode each cell explicitly for their oracle.
      const rows: unknown[][] = messages.flatMap(message => message.data || []);
      return { messages, rows };
    };
    const compileSourceSql = (query: string, principal: string) => {
      if (!options.grants.has(principal)) throw new Error('Unknown or revoked fixture principal');
      return gateway!.getSQLServer().sql4sql(query, true, { principal });
    };
    return { url, request, execute, compileSourceSql, connection, sourceRequests, logs, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

import { PassThrough, Readable } from 'stream';
import { BaseDriver, QueryKey, StreamOptions, StreamTableData } from '@cubejs-backend/base-driver';
import { QueryCache } from '../../src/orchestrator/QueryCache';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class StreamingDriver extends BaseDriver {
  public async testConnection(): Promise<void> { return undefined; }

  public async query<R = unknown>(): Promise<R[]> { return []; }

  public readonly stream = jest.fn<Promise<StreamTableData>, [string, unknown[], StreamOptions]>();
}

function startQueue(factory: () => Promise<BaseDriver> | BaseDriver) {
  const completed = deferred<void>();
  const logger = jest.fn((message: string) => {
    if (message === 'Performing query completed' || message === 'Error while querying') {
      completed.resolve();
    }
  });
  const queue = QueryCache.createQueue(`stream-cancel-${Math.random()}`, factory, () => [], {
    cacheAndQueueDriver: 'memory', logger,
  });
  const key: QueryKey = ['select streamed', []];
  key.persistent = true;
  const start = () => queue.executeInQueue('stream', key, {
    queryKey: key, query: 'select streamed', values: [], requestId: 'stream-cancel-request',
  }, 0, { requestId: 'stream-cancel-request' });
  return { queue, start, completed, logger };
}

describe('QueryCache source stream cancellation', () => {
  test('cancels before driver factory resolves without dispatching source work', async () => {
    const ready = deferred<BaseDriver>();
    const driver = new StreamingDriver();
    const { start, completed } = startQueue(() => ready.promise);
    const target = await start();
    target.destroy();
    await new Promise<void>(resolve => target.once('close', resolve));
    ready.resolve(driver);
    await completed.promise;
    expect(driver.stream).not.toHaveBeenCalled();
  });

  test('propagates target cancellation while driver setup waits for first fields', async () => {
    const driver = new StreamingDriver();
    const issued = deferred<AbortSignal>();
    driver.stream.mockImplementation((_query, _values, { signal }) => new Promise((_resolve, reject) => {
      issued.resolve(signal!);
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    }));
    const { queue, start, completed } = startQueue(() => driver);
    const target = await start();
    const signal = await issued.promise;
    expect(signal.aborted).toBe(false);
    expect(await queue.cancelQueryByRequestId('stream-cancel-request')).toHaveLength(1);
    await completed.promise;
    expect(signal.aborted).toBe(true);
    expect(target.destroyed).toBe(true);
  });

  test('still finds the source after first-row delivery removes its waiting handle', async () => {
    const source = new PassThrough({ objectMode: true });
    const driver = new StreamingDriver();
    const release = jest.fn(async () => undefined);
    let signal: AbortSignal | undefined;
    driver.stream.mockImplementation(async (_query, _values, options) => {
      signal = options.signal;
      return { rowStream: source, types: [], release };
    });
    const { queue, start, completed } = startQueue(() => driver);
    const target = await start();
    const first = deferred<unknown>();
    target.once('data', row => first.resolve(row));
    source.write({ id: 1 });
    expect(await first.promise).toEqual({ id: 1 });
    expect(queue.getQueryStream(target.queryKey)).toBeUndefined();
    const outcome = new Promise<void>(resolve => target.once('close', resolve));
    expect(await queue.cancelQueryByRequestId('stream-cancel-request')).toHaveLength(1);
    await outcome;
    await completed.promise;
    expect(signal!.aborted).toBe(true);
    expect(source.destroyed).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('normal completion releases once without cancelling the driver', async () => {
    const driver = new StreamingDriver();
    const release = jest.fn(async () => undefined);
    let signal: AbortSignal | undefined;
    driver.stream.mockImplementation(async (_query, _values, options) => {
      signal = options.signal;
      return { rowStream: Readable.from([{ id: 1 }, { id: 2 }]), types: [], release };
    });
    const { start, completed } = startQueue(() => driver);
    const target = await start();
    const rows = [];

    for await (const row of target) rows.push(row);
    await completed.promise;
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(signal!.aborted).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('cleans up a completed stream when driver release fails', async () => {
    const driver = new StreamingDriver();
    const source = Readable.from([{ id: 1 }]);
    const release = jest.fn(async () => { throw new Error('release failed'); });
    driver.stream.mockResolvedValue({ rowStream: source, types: [], release });
    const { start, completed, logger } = startQueue(() => driver);
    const target = await start();
    const rows = [];

    for await (const row of target) rows.push(row);
    await completed.promise;
    expect(rows).toEqual([{ id: 1 }]);
    expect(source.destroyed).toBe(true);
    expect(target.destroyed).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith('Error while querying', expect.objectContaining({
      error: expect.stringContaining('release failed'),
    }));
  });
});

import { createServer, Server, Socket } from 'net';
import { PgClient } from '../src/PgClient';

class ConnectedClient extends PgClient {
  public processID: number | null = 1234;

  public secretKey: number | null = 5678;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
}

describe('PostgreSQL CancelRequest transport', () => {
  test('sends only the authenticated backend key and completes when the server closes', async () => {
    let packet: Buffer | undefined;
    const server = createServer(socket => socket.once('data', data => {
      packet = data;
      socket.end();
    }));
    const port = await listen(server);
    const client = new ConnectedClient({ host: '127.0.0.1', port });

    try {
      await client.cancelCurrentQuery();
      expect(packet).toHaveLength(16);
      expect(packet!.readInt32BE(0)).toBe(16);
      expect(packet!.readInt32BE(4)).toBe(80877102);
      expect(packet!.readInt32BE(8)).toBe(1234);
      expect(packet!.readInt32BE(12)).toBe(5678);
    } finally {
      await close(server);
    }
  });

  test('does not open a cancellation socket before backend authentication', async () => {
    const connected = jest.fn();
    const server = createServer(connected);
    const port = await listen(server);
    const client = new ConnectedClient({ host: '127.0.0.1', port });
    client.processID = null;
    client.secretKey = null;

    try {
      await client.cancelCurrentQuery();
      expect(connected).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  test('bounds an unresponsive cancellation socket at five seconds and closes it', async () => {
    let observedSocket: Socket | undefined;
    let received!: () => void;
    const requestReceived = new Promise<void>(resolve => { received = resolve; });
    const server = createServer(socket => {
      observedSocket = socket;
      socket.once('data', received);
    });
    const port = await listen(server);
    const client = new ConnectedClient({ host: '127.0.0.1', port });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const result = client.cancelCurrentQuery().then(() => undefined, error => error);

    try {
      await requestReceived;
      let settled = false;
      result.then(() => { settled = true; });
      await jest.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(await result).toEqual(new Error('PostgreSQL cancellation timed out'));
      await new Promise<void>(resolve => observedSocket!.once('close', resolve));
      expect(observedSocket!.destroyed).toBe(true);
    } finally {
      jest.useRealTimers();
      observedSocket?.destroy();
      await close(server);
    }
  });
});

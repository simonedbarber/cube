import { Client, Connection, QueryResult, ClientConfig, QueryResultRow } from 'pg';

// node-postgres exposes these protocol operations at runtime but omits them
// from its public TypeScript declarations. Keep the boundary in one place.
type CancellationConnection = Connection & {
  connect(port: number | string, host?: string): void;
  cancel(processID: number, secretKey: number): void;
};

export class PgClient extends Client {
  public async cancelCurrentQuery(): Promise<void> {
    const { processID, secretKey } = this as unknown as {
      processID: number | null;
      secretKey: number | null;
    };
    if (processID === null || secretKey === null) {
      return;
    }

    // A CancelRequest uses the current connection's backend key and a separate
    // socket. It must not wait for another slot in the source connection pool.
    const connection = new Client({ ssl: false }).connection as CancellationConnection;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        connection.stream.destroy();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      timer = setTimeout(() => finish(new Error('PostgreSQL cancellation timed out')), 5000);
      connection.on('error', finish);
      connection.once('end', () => finish());
      connection.once('connect', () => connection.cancel(processID, secretKey));
      if (this.host.startsWith('/')) {
        connection.connect(`${this.host}/.s.PGSQL.${this.port}`);
      } else {
        connection.connect(this.port, this.host);
      }
    });
  }

  public isEnding(): boolean {
    return (this as any)._ending;
  }

  public isEnded(): boolean {
    return (this as any)._ended;
  }

  public isQueryable(): boolean {
    return (this as any)._queryable;
  }
}

export type PgClientConfig = ClientConfig;
export type PgQueryResult<T extends QueryResultRow = any> = QueryResult<T>;

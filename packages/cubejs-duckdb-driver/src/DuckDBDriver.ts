import {
  BaseDriver,
  DriverInterface,
  StreamOptions,
  QueryOptions,
  StreamTableData,
  GenericDataBaseType,
  TableStructure,
  TableColumnQueryResult,
} from '@cubejs-backend/base-driver';
import { getEnv } from '@cubejs-backend/shared';

import { DuckDBQuery } from './DuckDBQuery';
import { HydrationStream, transformRow } from './HydrationStream';
// QueryRails (Epic 27, task 27.12b): execution is routed through @duckdb/node-api
// (neo) v1.5.3 via NeoEngine, NOT the bundled classic `duckdb` (whose DuckLake ext
// only reads catalog format <= 0.3 and CANNOT attach the v1.5.3 writer's lake).
// NeoEngine exposes a classic-`duckdb`-shaped surface so the hooks below stay minimal.
import { openEngine, NeoConnection, NeoDb } from './NeoEngine';

const { version } = require('../../package.json');

export type DuckDBDriverConfiguration = {
  databasePath?: string,
  dataSource?: string,
  initSql?: string,
  motherDuckToken?: string,
  schema?: string,
  duckdbS3UseCredentialChain?: boolean,
  preAggregations?: boolean,
};

type InitPromise = {
  defaultConnection: NeoConnection,
  db: NeoDb;
};

const DuckDBToGenericType: Record<string, GenericDataBaseType> = {
  // DATE_TRUNC returns DATE, but Cube Store still doesn't support DATE type
  // DuckDB's driver transform date/timestamp to Date object, but HydrationStream converts any Date object to ISO timestamp
  // That's why It's safe to use timestamp here
  date: 'timestamp',
};

export class DuckDBDriver extends BaseDriver implements DriverInterface {
  protected initPromise: Promise<InitPromise> | null = null;

  private readonly schema: string;

  public constructor(
    protected readonly config: DuckDBDriverConfiguration = {},
  ) {
    super();

    this.schema = this.config.schema || getEnv('duckdbSchema', this.config);
  }

  protected override toGenericType(columnType: string, precision?: number | null, scale?: number | null): GenericDataBaseType {
    const match = columnType.trim().toLowerCase().match(/^numeric\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)$/i);

    if (match) {
      precision = Number(match[1]);
      scale = Number(match[2]);
    }

    return DuckDBToGenericType[columnType.toLowerCase()] || super.toGenericType(columnType.toLowerCase(), precision, scale);
  }

  private async installExtensions(extensions: string[], execAsync: (sql: string, ...params: any[]) => Promise<void>, repository: string = ''): Promise<void> {
    repository = repository ? ` FROM ${repository}` : '';
    for (const extension of extensions) {
      try {
        await execAsync(`INSTALL ${extension}${repository}`);
      } catch (e) {
        if (this.logger) {
          console.error(`DuckDB - error on installing ${extension}`, { e });
        }
        // DuckDB will lose connection_ref on connection on error, this will lead to broken connection object
        throw e;
      }
    }
  }

  private async loadExtensions(extensions: string[], execAsync: (sql: string, ...params: any[]) => Promise<void>): Promise<void> {
    for (const extension of extensions) {
      try {
        await execAsync(`LOAD ${extension}`);
      } catch (e) {
        if (this.logger) {
          console.error(`DuckDB - error on loading ${extension}`, { e });
        }
        // DuckDB will lose connection_ref on connection on error, this will lead to broken connection object
        throw e;
      }
    }
  }

  protected async init(): Promise<InitPromise> {
    const token = this.config.motherDuckToken || getEnv('duckdbMotherDuckToken', this.config);
    const dbPath = this.config.databasePath || getEnv('duckdbDatabasePath', this.config);
    // Determine the database URL based on the provided db_path or token
    let dbUrl: string;
    if (dbPath) {
      dbUrl = dbPath;
    } else if (token) {
      dbUrl = `md:?motherduck_token=${token}&custom_user_agent=Cube/${version}`;
    } else {
      dbUrl = ':memory:';
    }

    let dbOptions;
    if (token) {
      dbOptions = { custom_user_agent: `Cube/${version}` };
    }

    // QueryRails (27.12b): open the engine via @duckdb/node-api (neo) v1.5.3 instead
    // of `new duckdb.Database`. NeoEngine returns a classic-shaped
    // { defaultConnection, db } so the rest of init() (config SETs, extension load,
    // initSql) and query()/stream()/release() are unchanged in shape. execAsync runs
    // whole (possibly multi-statement) SQL scripts and REJECTS on the first failure.
    const { defaultConnection, db } = await openEngine(dbUrl, dbOptions);
    const execAsync = defaultConnection.execAsync;

    const configuration = [
      {
        key: 's3_region',
        value: getEnv('duckdbS3Region', this.config),
      },
      {
        key: 's3_endpoint',
        value: getEnv('duckdbS3Endpoint', this.config),
      },
      {
        key: 's3_access_key_id',
        value: getEnv('duckdbS3AccessKeyId', this.config),
      },
      {
        key: 's3_secret_access_key',
        value: getEnv('duckdbS3SecretAccessKeyId', this.config),
      },
      {
        key: 'memory_limit',
        value: getEnv('duckdbMemoryLimit', this.config),
      },
      {
        key: 'schema',
        value: getEnv('duckdbSchema', this.config),
      },
      {
        key: 's3_use_ssl',
        value: getEnv('duckdbS3UseSsl', this.config),
      },
      {
        key: 's3_url_style',
        value: getEnv('duckdbS3UrlStyle', this.config),
      },
      {
        key: 's3_session_token',
        value: getEnv('duckdbS3SessionToken', this.config),
      }
    ];

    for (const { key, value } of configuration) {
      if (value) {
        try {
          await execAsync(`SET ${key}='${value}'`);
        } catch (e) {
          if (this.logger) {
            console.error(`DuckDB - error on configuration, key: ${key}`, {
              e
            });
          }
        }
      }
    }

    const useCredentialChain = this.config.duckdbS3UseCredentialChain || getEnv('duckdbS3UseCredentialChain', this.config);
    if (useCredentialChain) {
      try {
        await execAsync('CREATE SECRET (TYPE S3, PROVIDER \'CREDENTIAL_CHAIN\')');
      } catch (e) {
        if (this.logger) {
          console.error('DuckDB - error on creating S3 credential chain secret', { e });
        }
        throw e;
      }
    }

    // Install & load extensions if configured in env variable.
    const officialExtensions = getEnv('duckdbExtensions', this.config);
    await this.installExtensions(officialExtensions, execAsync);
    await this.loadExtensions(officialExtensions, execAsync);
    const communityExtensions = getEnv('duckdbCommunityExtensions', this.config);
    // @see https://duckdb.org/community_extensions/
    await this.installExtensions(communityExtensions, execAsync, 'community');
    await this.loadExtensions(communityExtensions, execAsync);

    if (this.config.initSql) {
      // QueryRails (27.12b): cold-cache safety. The lake initSql begins with
      // `LOAD ducklake/postgres/httpfs;` but does NOT INSTALL them — on a fresh
      // engine with no extension cache those LOADs fail. INSTALL them first
      // (idempotent; a no-op once cached). Failure here is fatal: a lake reader
      // without ducklake/postgres/httpfs is useless.
      try {
        await execAsync('INSTALL ducklake; INSTALL postgres; INSTALL httpfs;');
      } catch (e) {
        if (this.logger) {
          console.error('DuckDB - error installing lake extensions', { e });
        }
        throw e;
      }
      // QueryRails (27.12b): THROW on initSql/ATTACH failure — do NOT swallow. The
      // stock driver swallowed it ("skipping"), so a failed ATTACH left the lake
      // un-attached and surfaced later as a misleading "Table does not exist".
      try {
        await execAsync(this.config.initSql);
      } catch (e) {
        if (this.logger) {
          console.error('DuckDB - error on init sql', { e });
        }
        throw e;
      }
    }

    return {
      defaultConnection,
      db
    };
  }

  public override informationSchemaQuery(): string {
    if (this.schema) {
      return `${super.informationSchemaQuery()} AND table_catalog = '${this.schema}'`;
    }

    return super.informationSchemaQuery();
  }

  public override getSchemasQuery(): string {
    if (this.schema) {
      return `
        SELECT table_schema as ${super.quoteIdentifier('schema_name')}
        FROM information_schema.tables
        WHERE table_catalog = '${this.schema}'
        GROUP BY table_schema
      `;
    }
    return super.getSchemasQuery();
  }

  protected async getInitiatedState(): Promise<InitPromise> {
    if (!this.initPromise) {
      this.initPromise = this.init();
    }

    try {
      return await this.initPromise;
    } catch (e) {
      this.initPromise = null;

      throw e;
    }
  }

  public static dialectClass() {
    return DuckDBQuery;
  }

  public async query<R = unknown>(query: string, values: unknown[] = [], _options?: QueryOptions): Promise<R[]> {
    // QueryRails (27.12b): execute via the neo connection's allAsync instead of
    // classic promisify(connection.all). Row objects are normalized by the existing
    // HydrationStream.transformRow — output shape is unchanged.
    const { defaultConnection } = await this.getInitiatedState();

    const result = await defaultConnection.allAsync<R>(query, ...values);
    return result.map((item) => {
      transformRow(item);

      return item;
    });
  }

  public async stream(
    query: string,
    values: unknown[],
    { highWaterMark }: StreamOptions
  ): Promise<StreamTableData> {
    // QueryRails (27.12b): stream via the neo connection's streamAsync (a Node
    // Readable of row objects backed by neo's chunked reader) instead of classic
    // `db.connect().stream(...)`. The neo connection is shared (the in-process
    // engine is per-driver), so a per-stream close is unnecessary and would break
    // the shared default connection; the engine is closed in the driver's release().
    const { defaultConnection } = await this.getInitiatedState();

    const rowStream = defaultConnection
      .streamAsync(query, values || [], highWaterMark)
      .pipe(new HydrationStream());

    return {
      rowStream,
      release: async () => {
        // No-op: the neo connection is owned by the driver (closed in release()).
      }
    };
  }

  public async testConnection(): Promise<void> {
    await this.query('SELECT 1', []);
  }

  public readOnly() {
    return false;
  }

  public async release(): Promise<void> {
    // QueryRails (27.12b): close the neo instance via NeoEngine's db.closeAsync()
    // instead of promisify(db.close).
    if (this.initPromise) {
      const { db } = await this.initPromise;
      this.initPromise = null;

      await db.closeAsync();
    }
  }
}

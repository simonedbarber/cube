import { DuckDBInstance } from '@duckdb/node-api';
import { DuckDBDriver } from '../../src';

const { version } = require('../../../package.json');

class TestDuckDBDriver extends DuckDBDriver {
  public async initialize() {
    await this.getInitiatedState();
  }
}

describe('DuckDBDriver initialization', () => {
  const originalEnv = { ...process.env };
  let driver: TestDuckDBDriver;
  let connection: { run: jest.Mock, closeSync: jest.Mock };
  let instance: { connect: jest.Mock, closeSync: jest.Mock };

  const clearDuckDBEnv = () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('CUBEJS_DB_DUCKDB_')) {
        delete process.env[key];
      }
    }
  };

  beforeEach(() => {
    clearDuckDBEnv();
    connection = { run: jest.fn().mockResolvedValue({}), closeSync: jest.fn() };
    instance = { connect: jest.fn().mockResolvedValue(connection), closeSync: jest.fn() };
    jest.spyOn(DuckDBInstance, 'create').mockResolvedValue(instance as unknown as DuckDBInstance);
    driver = new TestDuckDBDriver();
  });

  afterEach(async () => {
    await driver.release();
    jest.restoreAllMocks();
    clearDuckDBEnv();
    Object.assign(process.env, originalEnv);
  });

  test.each([
    [{}, ':memory:', undefined],
    [{ databasePath: '/test.duckdb' }, '/test.duckdb', undefined],
    [{ motherDuckToken: 'test-token' }, `md:?motherduck_token=test-token&custom_user_agent=Cube/${version}`, { custom_user_agent: `Cube/${version}` }],
    [{ databasePath: '/test.duckdb', motherDuckToken: 'test-token' }, '/test.duckdb', { custom_user_agent: `Cube/${version}` }],
  ])('selects the database for %j', async (config, path, options) => {
    driver = new TestDuckDBDriver(config);
    await driver.initialize();
    expect(DuckDBInstance.create).toHaveBeenCalledWith(path, options);
  });

  test('applies settings, credential chain, extensions and initSql in order', async () => {
    process.env.CUBEJS_DB_DUCKDB_S3_REGION = 'eu-west-1';
    process.env.CUBEJS_DB_DUCKDB_MEMORY_LIMIT = '256MB';
    process.env.CUBEJS_DB_DUCKDB_EXTENSIONS = 'httpfs, json';
    process.env.CUBEJS_DB_DUCKDB_COMMUNITY_EXTENSIONS = 'h3';
    driver = new TestDuckDBDriver({ duckdbS3UseCredentialChain: true, initSql: 'SELECT 1; SELECT 2;' });

    await driver.initialize();

    expect(connection.run.mock.calls.map(([sql]) => sql)).toEqual([
      "SET s3_region='eu-west-1'",
      "SET memory_limit='256MB'",
      "CREATE SECRET (TYPE S3, PROVIDER 'CREDENTIAL_CHAIN')",
      'INSTALL httpfs', 'INSTALL json', 'LOAD httpfs', 'LOAD json',
      'INSTALL h3 FROM community', 'LOAD h3',
      'SELECT 1; SELECT 2;',
    ]);
  });

  // QueryRails: initSql is fail-fast. A failed ATTACH must not leave a lake-less
  // engine serving queries, so the driver throws instead of logging "(skipping)".
  test('fails fast when initSql errors, and still ignores setting errors', async () => {
    process.env.CUBEJS_DB_DUCKDB_MEMORY_LIMIT = 'invalid';
    driver = new TestDuckDBDriver({ initSql: 'INVALID SQL' });
    connection.run.mockImplementation(async (sql: string) => {
      if (sql === 'INVALID SQL') {
        throw new Error('invalid SQL');
      }
    });

    await expect(driver.initialize()).rejects.toThrow('invalid SQL');

    expect(connection.run).toHaveBeenCalledWith('INVALID SQL');
    expect(connection.closeSync).toHaveBeenCalledTimes(1);
    expect(instance.closeSync).toHaveBeenCalledTimes(1);
  });

  // QueryRails: a DuckLake initSql INSTALLs ducklake/postgres/httpfs/spatial first, because
  // the lake initSql only LOADs them and a cold extension cache would fail.
  test('installs the lake extensions before a ducklake initSql', async () => {
    driver = new TestDuckDBDriver({ initSql: "ATTACH 'ducklake:postgres:...' AS lake;" });

    await driver.initialize();

    expect(connection.run.mock.calls.map(([sql]) => sql)).toEqual([
      'INSTALL ducklake; INSTALL postgres; INSTALL httpfs; INSTALL spatial;',
      'LOAD spatial;',
      "ATTACH 'ducklake:postgres:...' AS lake;",
    ]);
  });

  test('fails fast when the lake extension install errors', async () => {
    driver = new TestDuckDBDriver({ initSql: "ATTACH 'ducklake:postgres:...' AS lake;" });
    connection.run.mockImplementation(async (sql: string) => {
      if (sql.startsWith('INSTALL ducklake')) {
        throw new Error('no network');
      }
    });

    await expect(driver.initialize()).rejects.toThrow('no network');
    expect(connection.run).not.toHaveBeenCalledWith("ATTACH 'ducklake:postgres:...' AS lake;");
    expect(instance.closeSync).toHaveBeenCalledTimes(1);
  });

  test('fails before attaching when spatial LOAD errors and closes resources', async () => {
    const initSql = "ATTACH 'ducklake:postgres:...' AS lake;";
    driver = new TestDuckDBDriver({ initSql });
    connection.run.mockImplementation(async (sql: string) => {
      if (sql === 'LOAD spatial;') throw new Error('spatial unavailable');
    });

    await expect(driver.initialize()).rejects.toThrow('spatial unavailable');
    expect(connection.run).not.toHaveBeenCalledWith(initSql);
    expect(connection.closeSync).toHaveBeenCalledTimes(1);
    expect(instance.closeSync).toHaveBeenCalledTimes(1);
    expect(connection.closeSync.mock.invocationCallOrder[0]).toBeLessThan(instance.closeSync.mock.invocationCallOrder[0]);
  });

  test.each(['INSTALL json', 'LOAD json', "CREATE SECRET (TYPE S3, PROVIDER 'CREDENTIAL_CHAIN')"])(
    'closes the instance and retries after init fails at %s',
    async (statement) => {
      process.env.CUBEJS_DB_DUCKDB_EXTENSIONS = 'json';
      driver = new TestDuckDBDriver({ duckdbS3UseCredentialChain: true });
      connection.run.mockImplementation(async (sql: string) => {
        if (sql === statement) {
          throw new Error('initialization failed');
        }
      });

      await expect(driver.initialize()).rejects.toThrow('initialization failed');
      expect(connection.closeSync).toHaveBeenCalledTimes(1);
      expect(instance.closeSync).toHaveBeenCalledTimes(1);
      expect(connection.closeSync.mock.invocationCallOrder[0]).toBeLessThan(instance.closeSync.mock.invocationCallOrder[0]);

      connection.run.mockResolvedValue({});
      await driver.initialize();
      expect(DuckDBInstance.create).toHaveBeenCalledTimes(2);
    }
  );

  test('closes the instance when connecting fails and allows retry', async () => {
    instance.connect.mockRejectedValueOnce(new Error('cannot connect'));

    await expect(driver.initialize()).rejects.toThrow('cannot connect');
    expect(instance.closeSync).toHaveBeenCalledTimes(1);

    await driver.initialize();
    expect(DuckDBInstance.create).toHaveBeenCalledTimes(2);
  });

  test('release closes the connection before the instance, once', async () => {
    await driver.initialize();

    await Promise.all([driver.release(), driver.release()]);

    expect(connection.closeSync).toHaveBeenCalledTimes(1);
    expect(instance.closeSync).toHaveBeenCalledTimes(1);
    expect(connection.closeSync.mock.invocationCallOrder[0]).toBeLessThan(instance.closeSync.mock.invocationCallOrder[0]);
  });
});

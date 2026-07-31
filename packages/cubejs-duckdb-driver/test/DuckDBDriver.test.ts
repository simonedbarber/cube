import { streamToArray } from '@cubejs-backend/shared';
// eslint-disable-next-line import/no-extraneous-dependencies
import { DriverTests } from '@cubejs-backend/testing-shared';
import { isDownloadTableMemoryData } from '@cubejs-backend/base-driver';
import { DuckDBDriver } from '../src';

describe('DuckDBDriver', () => {
  let driver: DuckDBDriver;

  jest.setTimeout(2 * 60 * 1000);

  beforeAll(async () => {
    driver = new DuckDBDriver({});
    await driver.query('CREATE SCHEMA IF NOT EXISTS test;', []);
    await driver.uploadTable(
      'test.select_test',
      [
        { name: 'id', type: 'bigint' },
        { name: 'created', type: 'timestamp' },
        { name: 'created_date', type: 'date' },
        { name: 'price', type: 'decimal' },
      ],
      {
        rows: [
          { id: 1, created: '2020-01-01 01:01:01.11111', created_date: '2020-01-01', price: '100' },
          { id: 2, created: '2020-02-02 02:02:02.22222', created_date: '2020-02-02', price: '200' },
          { id: 3, created: '2020-03-03 03:03:03.33333', created_date: '2020-03-03', price: '300' }
        ]
      }
    );
  });

  afterAll(async () => {
    await driver.release();
  });

  test('query', async () => {
    const result = await driver.query('select * from test.select_test ORDER BY id ASC', []);
    expect(result).toEqual([
      { id: '1', created: '2020-01-01T01:01:01.111Z', created_date: '2020-01-01T00:00:00.000Z', price: '100' },
      { id: '2', created: '2020-02-02T02:02:02.222Z', created_date: '2020-02-02T00:00:00.000Z', price: '200' },
      { id: '3', created: '2020-03-03T03:03:03.333Z', created_date: '2020-03-03T00:00:00.000Z', price: '300' }
    ]);
  });

  test('query with Date parameter', async () => {
    const result = await driver.query('SELECT ?::TIMESTAMP AS created', [new Date('2020-04-04T04:04:04.444Z')]);

    expect(result).toEqual([
      { created: '2020-04-04T04:04:04.444Z' }
    ]);
  });

  test('query formats INTERVAL / TIME / TIME_TZ to display strings', async () => {
    // @duckdb/node-api's built-in JS converter reduces TIME to a bare bigint (micros)
    // and TIME_TZ / INTERVAL to bigint-bearing objects that JSON.stringify rejects.
    // cubeValueConverter instead renders them to DuckDB's canonical display strings
    // using the typed value's own toString(), so they are JSON-safe and human-readable.
    const result = await driver.query<Record<string, string>>(
      `SELECT
        INTERVAL '1 mon 2 days 3 hours' AS iv,
        TIME '04:05:06' AS t,
        TIMETZ '04:05:06+00' AS tz`,
      []
    );

    expect(result.length).toBe(1);
    expect(() => JSON.stringify(result)).not.toThrow();
    // TIME recovers its readable form (not a micros count).
    expect(result[0].t).toBe('04:05:06');
    // TIME_TZ keeps its offset.
    expect(result[0].tz).toBe('04:05:06+00');
    // INTERVAL renders to DuckDB's display form.
    expect(result[0].iv).toBe('1 month 2 days 03:00:00');
  });

  test('query serializes nested bigint inside structs/lists', async () => {
    // A struct containing a bigint (HUGEINT) and a list of bigints must not survive to
    // JSON.stringify — both are recursively stringified.
    const result = await driver.query<{ s: Record<string, string>, l: string[] }>(
      `SELECT {'big': 9223372036854775807::HUGEINT, 'name': 'x'} AS s, [1::BIGINT, 2::BIGINT] AS l`,
      []
    );

    expect(result.length).toBe(1);
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result[0].s).toEqual({ big: '9223372036854775807', name: 'x' });
    expect(result[0].l).toEqual(['1', '2']);
  });

  test('column types', async () => {
    expect(await driver.tableColumnTypes('test.select_test')).toEqual([
      {
        name: 'id',
        type: 'bigint',
      },
      {
        name: 'created',
        type: 'timestamp',
      },
      {
        name: 'created_date',
        type: 'timestamp',
      },
      {
        name: 'price',
        type: 'decimal(18,3)',
      }
    ]);
  });

  test('testConnection', async () => {
    await driver.testConnection();
  });

  test('type coercion matrix', async () => {
    // Mirrors the Postgres / ClickHouse type-coercion tests: every awkward DuckDB type
    // is rendered to Cube's wire shape. @duckdb/node-api returns JS built-ins
    // (Date, bigint, number, boolean) which transformRow normalizes:
    //   - DATE/TIMESTAMP -> Date -> ISO string
    //   - BIGINT/INTEGER/DOUBLE/DECIMAL -> number|bigint -> string (DECIMAL precision is
    //     lost because neo returns it as a JS double)
    //   - BOOLEAN -> boolean (transformRow does not stringify booleans)
    const data = await driver.query(
      `SELECT
        CAST('2020-01-01' AS DATE) AS d,
        CAST('2020-01-01 10:00:00.123' AS TIMESTAMP) AS ts,
        CAST('1.0' AS DECIMAL(10,2)) AS dec,
        CAST(1.5 AS DOUBLE) AS dbl,
        CAST(true AS BOOLEAN) AS b,
        CAST(42 AS BIGINT) AS bi,
        CAST(7 AS INTEGER) AS i`,
      []
    );

    expect(data).toEqual([
      {
        d: '2020-01-01T00:00:00.000Z',
        ts: '2020-01-01T10:00:00.123Z',
        dec: '1',
        dbl: '1.5',
        b: true,
        bi: '42',
        i: '7',
      }
    ]);
  });

  test('downloadQueryResults buffers rows and infers types', async () => {
    // DuckDB does not override downloadQueryResults, so it inherits BaseDriver's
    // implementation: it runs the query, buffers all rows, and infers a types array
    // client-side via detectTypesFromTabular. (streamImport is ignored until DuckDB
    // overrides downloadQueryResults to delegate to driver.stream() — a known gap.)
    const result = await driver.downloadQueryResults(
      'SELECT id, price FROM test.select_test ORDER BY id ASC',
      [],
      { highWaterMark: 1000, streamImport: false }
    );

    // The memory path returns DownloadTableMemoryData (rows + types).
    expect(isDownloadTableMemoryData(result)).toBe(true);
    if (!isDownloadTableMemoryData(result)) return;
    expect(result.rows).toEqual([
      { id: '1', price: '100' },
      { id: '2', price: '200' },
      { id: '3', price: '300' }
    ]);
    // detectTypesFromTabular infers from JS values; DuckDB stringifies numbers, so all
    // numeric columns resolve to the same heuristic type. Assert the structure + names,
    // not the exact inferred type (which is an internal heuristic, not a contract).
    expect(result.types.map((t: any) => t.name)).toEqual(['id', 'price']);
    expect(result.types.length).toBe(2);
  });

  test('getTablesQuery', async () => {
    const tables = await driver.getTablesQuery('test');
    expect(tables.map((t: any) => t.table_name)).toContain('select_test');
  });

  test('stream (exception)', async () => {
    // Errors from bad SQL / missing tables must surface (not be swallowed).
    await expect(
      driver.stream('select * from test.table_that_does_not_exist', [], {
        highWaterMark: 1000,
      })
    ).rejects.toThrow();
  });

  test('stream', async () => {
    const tableData = await driver.stream('select * from test.select_test ORDER BY id ASC', [], {
      highWaterMark: 1000,
    });

    expect(await tableData.types).toEqual(undefined);
    expect(await streamToArray(tableData.rowStream as any)).toEqual([
      { id: '1', created: '2020-01-01T01:01:01.111Z', created_date: '2020-01-01T00:00:00.000Z', price: '100' },
      { id: '2', created: '2020-02-02T02:02:02.222Z', created_date: '2020-02-02T00:00:00.000Z', price: '200' },
      { id: '3', created: '2020-03-03T03:03:03.333Z', created_date: '2020-03-03T00:00:00.000Z', price: '300' }
    ]);
  });

  test('stream with Date parameter', async () => {
    const tableData = await driver.stream('SELECT ?::TIMESTAMP AS created', [new Date('2020-04-04T04:04:04.444Z')], {
      highWaterMark: 1000,
    });

    expect(await streamToArray(tableData.rowStream as any)).toEqual([
      { created: '2020-04-04T04:04:04.444Z' }
    ]);
  });

  test('stream tolerates null values', async () => {
    // stream(query, null) must not throw — the legacy driver tolerated null params.
    const tableData = await driver.stream('SELECT 1 AS v', null as any, {
      highWaterMark: 1000,
    });

    expect(await streamToArray(tableData.rowStream as any)).toEqual([{ v: '1' }]);
  });
});

describe('DuckDBDriver release', () => {
  // Uses an isolated driver so releasing does not affect the shared driver above.
  test('release is safe to call twice', async () => {
    const localDriver = new DuckDBDriver({});
    await localDriver.query('SELECT 1', []);
    await localDriver.release();
    await localDriver.release();
  });

  test('release without any query is a no-op', async () => {
    const localDriver = new DuckDBDriver({});
    await localDriver.release();
  });
});

// Tier 2: shared conformance baseline via @cubejs-backend/testing-shared's DriverTests,
// the same harness BigQuery uses. DriverTests is connection-agnostic; its static QUERY is
// a plain SELECT. DuckDB stringifies numbers (transformRow), so expectStringFields matches.
// unload methods are skipped (DuckDB has no export bucket).
describe('DriverTests conformance', () => {
  let tests: DriverTests;

  jest.setTimeout(2 * 60 * 1000);

  beforeAll(() => {
    tests = new DriverTests(new DuckDBDriver({}), { expectStringFields: true });
  });

  afterAll(async () => {
    await tests.release();
  });

  test('query', async () => {
    await tests.testQuery();
  });

  test('stream', async () => {
    await tests.testStream();
  });
});

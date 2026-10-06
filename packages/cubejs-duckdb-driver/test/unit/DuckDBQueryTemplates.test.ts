import { prepareCompiler as originalPrepareCompiler } from '@cubejs-backend/schema-compiler';
import { DuckDBInstance, type DuckDBValue } from '@duckdb/node-api';
import { DuckDBQuery } from '../../src/DuckDBQuery';

const prepareCompiler = (content: string) => originalPrepareCompiler({
  localPath: () => __dirname,
  dataSchemaFiles: () => Promise.resolve([
    { fileName: 'main.js', content }
  ])
}, { adapter: 'postgres' });

describe('DuckDBQuery SQL templates', () => {
  // DuckDB has no default LIKE escape character - the `default_escape` gate on
  // its `expressions.like`/`ilike` templates is the repo's own record of that.
  // The native planner escapes `%`, `_` and `\` in the filter value (BaseQuery's
  // `like_escape_char`), so the statement has to carry the clause that
  // interprets that escaping; without one a user searching for a literal `%`
  // matches nothing instead of the rows containing a percent sign.
  it.each([['legacy', false], ['tesseract', true]])(
    'escapes LIKE wildcards in filter values on the %s planner',
    async (_name, useNativeSqlPlanner) => {
      const { compiler, joinGraph, cubeEvaluator } = prepareCompiler(`
        cube('orders', {
          sql_table: 'orders',

          measures: {
            count: {
              type: 'count',
            },
          },

          dimensions: {
            id: {
              sql: 'id',
              type: 'number',
              primary_key: true,
            },
            status: {
              sql: 'status',
              type: 'string',
            },
          },
        });
      `);

      await compiler.compile();

      const query = new DuckDBQuery({ joinGraph, cubeEvaluator, compiler }, {
        measures: ['orders.count'],
        filters: [{ member: 'orders.status', operator: 'contains', values: ['%'] }],
        useNativeSqlPlanner,
      });

      const [sql, params] = query.buildSqlAndParams();

      expect(params).toEqual(['\\%']);

      // Only the native planner emits the clause: the legacy path relies on
      // DuckDB reading a bare backslash as the escape character, which is the
      // behaviour it has always had here.
      if (useNativeSqlPlanner) {
        // eslint-disable-next-line quotes -- double quotes keep the SQL readable
        expect(sql).toContain("ESCAPE '\\'");
      } else {
        expect(sql).not.toContain('ESCAPE');
      }
    }
  );
});

function boundParameters(values: readonly unknown[]): DuckDBValue[] {
  return values.map(value => {
    // The fixture uses SQL scalar parameters only; narrow them before the
    // native driver's typed binding API instead of asserting unknown[].
    if (value === null || typeof value === 'string' || typeof value === 'number'
      || typeof value === 'boolean' || typeof value === 'bigint') return value;
    throw new Error('Unexpected non-scalar time-series fixture parameter');
  });
}

describe('DuckDBQuery generated time series', () => {
  const buildQuery = async ({
    granularity = 'day', dateRange, status, measure = 'events.cumulative_users',
  }: {
    granularity?: string;
    dateRange?: [string, string];
    status?: string;
    measure?: string;
  } = {}) => {
    const { compiler, joinGraph, cubeEvaluator } = prepareCompiler(`
      cube('events', {
        sql_table: 'events',
        dimensions: {
          invited_at: {
            sql: 'invited_at', type: 'time',
            granularities: {
              two_weeks: { interval: '2 weeks', origin: '2024-01-01' },
            },
          },
          status: { sql: 'status', type: 'string' },
        },
        measures: {
          cumulative_users: {
            sql: 'user_id', type: 'count_distinct',
            rolling_window: { trailing: 'unbounded' },
          },
          rolling_30d_users: {
            sql: 'user_id', type: 'count_distinct',
            rolling_window: { trailing: '30 day' },
          },
        },
      });
    `);
    await compiler.compile();
    return new DuckDBQuery({ joinGraph, cubeEvaluator, compiler }, {
      measures: [measure],
      timeDimensions: [{ dimension: 'events.invited_at', granularity, ...(dateRange ? { dateRange } : {}) }],
      ...(status ? { filters: [{ member: 'events.status', operator: 'equals', values: [status] }] } : {}),
      order: [{ id: 'events.invited_at', desc: false }],
      timezone: 'UTC',
      useNativeSqlPlanner: true,
    });
  };

  it.each(['second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'])(
    'uses the database generator for %s with a derived range',
    async (granularity) => {
      const [sql] = (await buildQuery({ granularity })).buildSqlAndParams();
      expect(sql).toContain('LATERAL generate_series(');
      expect(sql).toContain('AS series(d)');
      expect(sql).toContain('AS "date_from"');
      expect(sql).toContain('AS "date_to"');
      expect(sql).toContain('INTERVAL \'1 millisecond\'');
    }
  );

  it('uses the explicit range template and retains bounded rolling planning', async () => {
    const [dated] = (await buildQuery({ dateRange: ['2024-01-02', '2024-01-04'] })).buildSqlAndParams();
    expect(dated).toContain('FROM generate_series(CAST(');
    expect(dated).not.toContain('LATERAL generate_series(');
    expect(dated).toContain('AS series(d)');
    const [bounded] = (await buildQuery({ measure: 'events.rolling_30d_users' })).buildSqlAndParams();
    expect(bounded).toContain('LATERAL generate_series(');
  });

  it('preserves the custom-granularity restriction and dated fallback', async () => {
    const withoutRange = await buildQuery({ granularity: 'two_weeks' });
    expect(withoutRange.supportGeneratedSeriesForCustomTd()).toBe(false);
    expect(() => withoutRange.buildSqlAndParams()).toThrow('Date range is required for time series');
    const [dated] = (await buildQuery({ granularity: 'two_weeks', dateRange: ['2024-01-01', '2024-02-29'] })).buildSqlAndParams();
    expect(dated).toContain('VALUES');
    expect(dated).not.toContain('generate_series(');
  });

  // Execute the actual compiled templates locally. This verifies DuckDB column
  // aliasing, derived bounds and sparse cumulative values; it is not a pinned
  // Cube/lake transport qualification or permission to lift the host gate.
  it('derives bounds only from filtered source rows, retaining sparse periods and empty input', async () => {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      // Pin source instants explicitly: converting an unzoned TIMESTAMP to
      // TIMESTAMPTZ uses the host session timezone (e.g. Australia/Sydney).
      // The oracle below describes UTC instants, independent of that session.
      await connection.run('CREATE TABLE events(user_id INTEGER, invited_at TIMESTAMPTZ, status VARCHAR)');
      await connection.run(`INSERT INTO events VALUES
        (1, '2024-01-01 00:00:00+00', 'paid'), (2, '2024-01-03 00:00:00+00', 'paid'), (3, '2024-01-04 00:00:00+00', 'paid'),
        (4, '2023-12-01 00:00:00+00', 'unpaid'), (5, '2024-01-20 00:00:00+00', 'unpaid')`);
      const query = await buildQuery({ status: 'paid' });
      const [sql, params] = query.buildSqlAndParams();
      expect(sql).toContain('LATERAL generate_series(');
      const rows = await (await connection.run(sql, boundParameters(params))).getRowObjects();
      expect(rows.map(row => [String(row.events__invited_at_day).slice(0, 10), Number(row.events__cumulative_users)])).toEqual([
        ['2024-01-01', 1], ['2024-01-02', 1], ['2024-01-03', 2], ['2024-01-04', 3],
      ]);
      const [dated, datedParams] = (await buildQuery({ status: 'paid', dateRange: ['2024-01-02', '2024-01-04'] })).buildSqlAndParams();
      const datedRows = await (await connection.run(dated, boundParameters(datedParams))).getRowObjects();
      expect(datedRows.map(row => [String(row.events__invited_at_day).slice(0, 10), Number(row.events__cumulative_users)])).toEqual([
        ['2024-01-02', 1], ['2024-01-03', 2], ['2024-01-04', 3],
      ]);
      const [empty, emptyParams] = (await buildQuery({ status: 'missing' })).buildSqlAndParams();
      expect(await (await connection.run(empty, boundParameters(emptyParams))).getRowObjects()).toEqual([]);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });
});

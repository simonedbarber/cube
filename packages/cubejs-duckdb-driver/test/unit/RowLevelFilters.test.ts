import { prepareCompiler } from '@cubejs-backend/schema-compiler';
import { DuckDBInstance, type DuckDBValue } from '@duckdb/node-api';
import { DuckDBQuery } from '../../src/DuckDBQuery';

const model = `
  cube('orders', {
    sql_table: 'orders',
    joins: { customers: { relationship: 'many_to_one',
      sql: \`\${orders}.customer_id = \${customers}.customer_id AND \${orders}.segment_id = \${customers}.segment_id\` } },
    dimensions: {
      order_id: { sql: 'order_id', type: 'number', primary_key: true },
      customer_id: { sql: 'customer_id', type: 'number' },
      segment_id: { sql: 'segment_id', type: 'number' },
      region: { sql: 'region', type: 'string' },
      status: { sql: 'status', type: 'string' },
    },
  });
  cube('customers', {
    sql: 'SELECT * FROM customers WHERE customer_id <> 3', sql_alias: 'visible_customers',
    dimensions: {
      customer_id: { sql: 'customer_id', type: 'number', primary_key: true },
      segment_id: { sql: 'segment_id', type: 'number', primary_key: true },
      region: { sql: 'region', type: 'string' },
      value_label: { sql: 'value_label', type: 'string' },
    },
  });
`;
const condition = (cube: string, values = ['A']) => ({ member: `${cube}.region`, operator: 'equals', values });

function parameters(values: readonly unknown[]): DuckDBValue[] {
  return values.map(value => {
    if (value === null || typeof value === 'string' || typeof value === 'number'
      || typeof value === 'boolean' || typeof value === 'bigint') return value;
    throw new Error('Unexpected non-scalar policy fixture parameter');
  });
}

describe('Native protected LEFT-join input placement', () => {
  let instance: DuckDBInstance;
  let connection: Awaited<ReturnType<DuckDBInstance['connect']>>;
  let compilers: ReturnType<typeof prepareCompiler>;
  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
    connection = await instance.connect();
    await connection.run(`CREATE TABLE orders(order_id INTEGER PRIMARY KEY, customer_id INTEGER, segment_id INTEGER, region VARCHAR, status VARCHAR);
      CREATE TABLE customers(customer_id INTEGER NOT NULL, segment_id INTEGER NOT NULL, region VARCHAR, value_label VARCHAR, PRIMARY KEY(customer_id, segment_id));
      INSERT INTO customers VALUES (1,1,'A','first'),(1,2,'A','second'),(2,1,'B','hidden'),(3,1,'A','clipped');
      INSERT INTO orders VALUES (1,1,1,'A','paid'),(2,1,2,'A','paid'),(3,2,1,'A','paid'),
        (4,NULL,1,'A','paid'),(5,99,1,'A','paid'),(6,3,1,'A','paid'),(7,1,NULL,'A','paid'),
        (8,1,1,'B','paid'),(9,1,1,'A','unpaid');`);
    compilers = prepareCompiler({ localPath: () => __dirname,
      dataSchemaFiles: async () => [{ fileName: 'policy-inputs.js', content: model }] }, { adapter: 'postgres' });
    await compilers.compiler.compile();
  });
  afterAll(() => { connection?.closeSync(); instance?.closeSync(); });

  async function run({ authoredRight = false, rightRegion = 'A', limit = 20, offset = 0, resultFilter = false } = {}) {
    const left = condition('orders');
    const right = condition('customers', [rightRegion]);
    const query = new DuckDBQuery(compilers, {
      dimensions: ['orders.order_id', 'customers.value_label', 'customers.customer_id', 'customers.segment_id'],
      ungrouped: true,
      filters: [{ member: 'orders.status', operator: 'equals', values: ['paid'] },
        ...(authoredRight ? [right] : []), { and: [left, right] }],
      rowLevelFilters: [{ cube: 'orders', filter: left }, { cube: 'customers', filter: right }],
      order: [{ id: 'orders.order_id', desc: false }],
      rowLimit: limit,
      offset,
      memberToAlias: { 'orders.order_id': 'order_id', 'customers.value_label': 'value_label' },
      timezone: 'UTC',
      useNativeSqlPlanner: true,
    });
    const [sql, values] = query.buildSqlAndParams();
    // Execute the exact native source SQL and apply the explicit fallback in a
    // relational projection. This is source evidence, not a pinned API capture.
    const wrapped = `SELECT order_id, COALESCE(value_label, 'missing') AS label
      FROM (${sql}) AS visible_rows ${resultFilter ? 'WHERE value_label IS NULL' : ''} ORDER BY order_id`;
    const rows = await (await connection.run(wrapped, parameters(values))).getRowObjects();
    return { sql, rows: rows.map(row => [Number(row.order_id), row.label]) };
  }

  it('retains NULL, absent, source-clipped and policy-hidden matches with full composite-key identity', async () => {
    const { sql, rows } = await run();
    expect(rows).toEqual([[1, 'first'], [2, 'second'], [3, 'missing'], [4, 'missing'], [5, 'missing'], [6, 'missing'], [7, 'missing']]);
    expect(sql).toContain('visible_customers');
    expect(rows.some(row => row[1] === 'hidden' || row[1] === 'clipped')).toBe(false);
  });

  it('pages after right-input visibility has preserved unmatched left rows', async () => {
    expect((await run({ limit: 3, offset: 2 })).rows).toEqual([[3, 'missing'], [4, 'missing'], [5, 'missing']]);
  });

  it('retains unmatched rows for the subsequent result filter', async () => {
    expect((await run({ resultFilter: true })).rows).toEqual([[3, 'missing'], [4, 'missing'], [5, 'missing'], [6, 'missing'], [7, 'missing']]);
  });

  it('keeps an identical user-authored right predicate after the join', async () => {
    expect((await run({ authoredRight: true })).rows).toEqual([[1, 'first'], [2, 'second']]);
  });

  it('does not reuse right-policy visibility from a different current population', async () => {
    expect((await run({ rightRegion: 'B' })).rows).toEqual([[1, 'missing'], [2, 'missing'], [3, 'hidden'], [4, 'missing'], [5, 'missing'], [6, 'missing'], [7, 'missing']]);
    expect((await run()).rows.slice(0, 3)).toEqual([[1, 'first'], [2, 'second'], [3, 'missing']]);
  });
});

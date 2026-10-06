import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

const policy = `access_policy: [
  { group: 'analyst', member_level: { includes: '*' }, row_level: { filters: [{ member: 'region', operator: 'equals', values: ['A'] }] } },
  { group: 'auditor', member_level: { includes: '*' }, row_level: { allow_all: true } }
]`;
const model = (rightRegion: 'A' | 'B') => `
cube('canonical_lookup_orders', { sql_table: 'canonical_lookup_orders', ${policy},
  joins: { canonical_lookup_customers: { relationship: 'many_to_one',
    sql: \`\${canonical_lookup_orders}.customer_id = \${canonical_lookup_customers}.customer_id AND \${canonical_lookup_orders}.segment_id = \${canonical_lookup_customers}.segment_id\` } },
  dimensions: {
    order_id: { sql: 'order_id', type: 'number', primary_key: true, public: true },
    customer_id: { sql: 'customer_id', type: 'number' }, segment_id: { sql: 'segment_id', type: 'number' },
    region: { sql: 'region', type: 'string' }, status: { sql: 'status', type: 'string' }
  }
});
cube('canonical_lookup_customers', { sql: 'SELECT * FROM canonical_lookup_customers WHERE customer_id <> 3', ${policy.replace("values: ['A']", `values: ['${rightRegion}']`)},
  dimensions: {
    customer_id: { sql: 'customer_id', type: 'number', primary_key: true, public: true },
    segment_id: { sql: 'segment_id', type: 'number', primary_key: true, public: true },
    value_label: { sql: 'value_label', type: 'string' }, region: { sql: 'region', type: 'string' }
  }
});`;
type Shape = 'FULL' | 'NULL-FALLBACK' | 'PAGE' | 'EMPTY' | 'RESULT-FILTER';
const analystRows = [[101, 'one'], [102, null], [103, 'missing'], [104, 'missing'], [105, 'missing'], [106, 'missing'], [108, 'missing']];
const auditorRows = [[101, 'one'], [102, null], [103, 'missing'], [104, 'missing'], [105, 'missing'], [106, 'blocked'], [107, 'one'], [108, 'missing']];
function expected(shape: Shape, principal: string) {
  const rows = principal === 'analyst' ? analystRows : auditorRows;
  if (shape === 'EMPTY') return [];
  if (shape === 'PAGE') return rows.slice(2, 5);
  if (shape === 'RESULT-FILTER') return rows.filter(row => row[1] === 'missing');
  if (shape === 'NULL-FALLBACK') return rows.map(([id, label]) => [id, label === 'missing' ? null : label]);
  return rows;
}
function sql(shape: Shape): string {
  const base = `SELECT canonical_lookup_orders.order_id AS "order_id",
    CASE WHEN canonical_lookup_customers.customer_id IS NULL THEN ${shape === 'NULL-FALLBACK' ? 'NULL' : "'missing'"}
      ELSE canonical_lookup_customers.value_label END AS "label"
    FROM canonical_lookup_orders LEFT JOIN canonical_lookup_customers
      ON canonical_lookup_orders.__cubeJoinField = canonical_lookup_customers.__cubeJoinField
    WHERE canonical_lookup_orders.status = 'paid' ${shape === 'EMPTY' ? 'AND canonical_lookup_orders.order_id = 999' : ''}
    GROUP BY 1, 2`;
  if (shape === 'PAGE') return `WITH base AS (${base}) SELECT base."order_id" AS "order_id", base."label" AS "label" FROM base ORDER BY "order_id" LIMIT 3 OFFSET 2`;
  if (shape === 'RESULT-FILTER') {
    return `WITH base AS (${base}), filtered AS (
    SELECT base."order_id" AS "order_id", base."label" AS "label" FROM base WHERE base."label" = 'missing'
  ) SELECT filtered."order_id" AS "order_id", filtered."label" AS "label" FROM filtered ORDER BY "order_id" LIMIT 20`;
  }
  return `${base} ORDER BY 1 LIMIT 20`;
}

/** Real HTTP gateway, current model policies, SQL parser and native planner.
 * The in-memory source adapter executes SQL rather than synthesizing rows.
 * This supplemental native-source fixture is not a released-runtime or
 * QueryRails source/product authority qualification. */
describe('Protected canonical LOOKUP through the SQL HTTP endpoint', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  const grants = new Map([['analyst', ['analyst']], ['auditor', ['auditor']]]);
  let rightRegion: 'A' | 'B' = 'A';
  let modelRevision = 1;

  beforeAll(async () => {
    endpoint = await startSemanticSqlEndpoint({
      model: () => model(rightRegion),
      schemaVersion: () => String(modelRevision),
      grants,
      setupSQL: `CREATE TABLE canonical_lookup_orders(order_id INTEGER PRIMARY KEY, customer_id INTEGER, segment_id INTEGER, region VARCHAR, status VARCHAR);
      CREATE TABLE canonical_lookup_customers(customer_id INTEGER NOT NULL, segment_id INTEGER NOT NULL, value_label VARCHAR, region VARCHAR, PRIMARY KEY(customer_id, segment_id));
      INSERT INTO canonical_lookup_customers VALUES (1,10,'one','A'),(1,20,NULL,'A'),(2,10,'blocked','B'),(3,30,'clipped','A');
      INSERT INTO canonical_lookup_orders VALUES (101,1,10,'A','paid'),(102,1,20,'A','paid'),(103,9,10,'A','paid'),
        (104,NULL,10,'A','paid'),(105,1,NULL,'A','paid'),(106,2,10,'A','paid'),(107,1,10,'B','paid'),
        (108,3,30,'A','paid'),(109,1,10,'A','unpaid');`,
    });
  });
  afterAll(async () => { await endpoint?.stop(); });

  function request(shape: Shape, principal: string) {
    return endpoint.request(sql(shape), principal);
  }
  async function run(shape: Shape, principal: string) {
    const start = endpoint.sourceRequests.length;
    const { messages } = await endpoint.execute(sql(shape), principal);
    if (shape === 'RESULT-FILTER') {
      console.log('protected lookup result-filter transport', JSON.stringify({ principal, messages, sourceRequests: endpoint.sourceRequests.slice(start) }));
    }
    expect(messages.find(message => message.schema)?.schema).toEqual([
      { name: 'order_id', column_type: 'Double' }, { name: 'label', column_type: 'String' },
    ]);
    // Native HTTP JSONL sends numeric cells as strings under its typed schema.
    const rows = messages.flatMap(message => message.data || []).map(row => {
      expect(typeof row[0]).toBe('string');
      const id = Number(row[0]);
      expect(Number.isFinite(id)).toBe(true);
      return [id, row[1]];
    });
    return { messages, rows };
  }

  test.each((['FULL', 'NULL-FALLBACK', 'PAGE', 'EMPTY', 'RESULT-FILTER'] as const)
    .flatMap(shape => ['analyst', 'auditor'].map(principal => ({ shape, principal }))))(
    '$shape preserves the current $principal population and matched NULL semantics', async ({ shape, principal }) => {
      expect((await run(shape, principal)).rows).toEqual(expected(shape, principal));
    }
  );

  test('places only the right policy in ON while retaining source clipping, composite keys and root visibility', async () => {
    const start = endpoint.sourceRequests.length;
    await run('FULL', 'analyst');
    const issued = endpoint.sourceRequests.slice(start);
    expect(issued).toHaveLength(1);
    const [beforeWhere, afterWhere] = issued[0].query.split('  WHERE ');
    expect(beforeWhere).toContain('WHERE customer_id <> 3');
    expect(beforeWhere).toContain('"canonical_lookup_orders".segment_id = "canonical_lookup_customers".segment_id');
    expect(beforeWhere).toContain('"canonical_lookup_customers".region = ?');
    expect(afterWhere).toContain('"canonical_lookup_orders".region = ?');
    expect(afterWhere).not.toContain('"canonical_lookup_customers".region');
    expect(issued[0].values).toEqual(['missing', 'A', 'paid', 'A']);
    expect(issued[0].principal).toBe('analyst');
  });

  test('does not reuse another principal population in a warm native/compiler plan', async () => {
    for (const principal of ['analyst', 'auditor', 'analyst']) {
      expect((await run('FULL', principal)).rows).toEqual(expected('FULL', principal));
    }
  });

  test('revoked HTTP credentials issue no source work and restoring credentials recovers current rows', async () => {
    await run('FULL', 'analyst');
    const start = endpoint.sourceRequests.length;
    grants.delete('analyst');

    try {
      const response = await request('FULL', 'analyst');
      expect(response.status).toBe(403);
      expect(await response.text()).toContain('Unknown or revoked fixture principal');
      expect(endpoint.sourceRequests).toHaveLength(start);
    } finally { grants.set('analyst', ['analyst']); }
    expect((await run('FULL', 'analyst')).rows).toEqual(analystRows);
  });

  test('current grant removal invalidates warm metadata before source dispatch', async () => {
    await run('FULL', 'analyst');
    const start = endpoint.sourceRequests.length;
    grants.set('analyst', []);

    try {
      await expect(run('FULL', 'analyst')).rejects.toThrow(/Planning Error|not found|not available|not allowed/i);
      expect(endpoint.sourceRequests).toHaveLength(start);
    } finally { grants.set('analyst', ['analyst']); }
    expect((await run('FULL', 'analyst')).rows).toEqual(analystRows);
  });

  test('a changed current model policy replaces warm right-input visibility', async () => {
    await run('FULL', 'analyst');
    rightRegion = 'B';
    modelRevision++;

    try {
      expect((await run('FULL', 'analyst')).rows).toEqual([
        [101, 'missing'], [102, 'missing'], [103, 'missing'], [104, 'missing'], [105, 'missing'], [106, 'blocked'], [108, 'missing'],
      ]);
    } finally { rightRegion = 'A'; modelRevision++; }
    expect((await run('FULL', 'analyst')).rows).toEqual(analystRows);
  });
});

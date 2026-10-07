import { PostgresDriver } from '@cubejs-backend/postgres-driver';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

// This suite requires a task-owned PostgreSQL listener; it never writes source
// fixtures or uses the developer's database. The launcher supplies its port.
const ownedPort = process.env.CUBE_MASKED_ORDER_TEST_POSTGRES_PORT;
const describePostgres = ownedPort ? describe : describe.skip;
const model = (maskSQL?: string) => `cube('governed_sales', {
  sql: "SELECT * FROM (VALUES (1, 'north', 'web', 10.0::float8), (2, 'north', 'retail', 20.0::float8), (3, 'south', 'secret', 50.0::float8)) AS sales(sale_id, region, channel, amount)",
  dimensions: {
    sale_id: { sql: 'sale_id', type: 'number', primary_key: true, public: true },
    region: { sql: 'region', type: 'string' },
    channel: { sql: 'channel', type: 'string'${maskSQL === undefined ? '' : `, mask: { sql: ${JSON.stringify(maskSQL)} }`} }
  },
  measures: { total_amount: { sql: 'amount', type: 'sum' } },
  access_policy: [
    { group: 'analyst', member_level: { includes: ['sale_id', 'region', 'total_amount'] },
      member_masking: { includes: ['channel'] },
      row_level: { filters: [{ member: 'region', operator: 'equals', values: ['north'] }] } },
    { group: 'auditor', member_level: { includes: '*' }, row_level: { allow_all: true } }
  ]
});`;

/** Actual native SQL HTTP, PostgreSQL source driver and compiled policies.
 * Current QueryRails product/grant authority is outside this source regression. */
describePostgres('Masked selected-column sorting on PostgreSQL', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  const grants = new Map([['analyst', ['analyst']], ['auditor', ['auditor']]]);
  let maskSQL: string | undefined = "'MASKED'";
  let revision = 1;
  beforeAll(async () => {
    endpoint = await startSemanticSqlEndpoint({
      model: () => model(maskSQL),
      schemaVersion: () => String(revision),
      setupSQL: '',
      grants,
      streamMode: true,
      sourceDialect: 'postgres',
      sourceDriver: new PostgresDriver({
        host: '127.0.0.1',
        port: Number(ownedPort),
        user: 'postgres',
        password: 'owned-masked-order-fixture',
        database: 'postgres',
        maxPoolSize: 2,
        readOnly: true
      })
    });
  });
  afterAll(async () => { await endpoint?.stop(); });

  function sql(direction: 'ASC' | 'DESC', placement: 'FIRST' | 'LAST') {
    return `SELECT region, channel, MEASURE(governed_sales.total_amount) AS total_amount
      FROM governed_sales GROUP BY 1, 2
      ORDER BY 1 ${direction} NULLS ${placement}, 2 ${direction} NULLS ${placement}`;
  }
  function amounts(rows: unknown[][]) {
    return rows.map(([region, channel, amount]) => [region, channel, Number(amount)]);
  }

  const combinations = (['ASC', 'DESC'] as const)
    .flatMap(direction => (['FIRST', 'LAST'] as const).map(placement => ({ direction, placement })));

  test.each(combinations)(
    '$direction NULLS $placement preserves mask, row policy and aggregation', async ({ direction, placement }) => {
      const start = endpoint.sourceRequests.length;
      const result = await endpoint.execute(sql(direction, placement), 'analyst');
      expect(amounts(result.rows)).toEqual([['north', 'MASKED', 30]]);
      const issued = endpoint.sourceRequests.slice(start);
      expect(issued.length).toBeGreaterThan(0);
      expect(issued.every(request => request.completed && request.principal === 'analyst')).toBe(true);
      expect(issued.every(request => request.query.includes("'MASKED'") &&
        request.query.includes('WHERE') && request.values.includes('north'))).toBe(true);
      expect(issued.every(request => new RegExp(`ORDER BY\\s+1 ${direction} NULLS ${placement},\\s*2 ${direction} NULLS ${placement}`).test(request.query))).toBe(true);
      console.log('masked order source capture', JSON.stringify({ direction, placement, rows: result.rows, sourceRequests: issued }));
    }
  );

  test('warm plans retain each principal mask and visible population', async () => {
    for (const principal of ['analyst', 'auditor', 'analyst']) {
      const start = endpoint.sourceRequests.length;
      const result = amounts((await endpoint.execute(sql('ASC', 'LAST'), principal)).rows);
      expect(result).toEqual(principal === 'analyst' ? [['north', 'MASKED', 30]] :
        [['north', 'retail', 20], ['north', 'web', 10], ['south', 'secret', 50]]);
      const issued = endpoint.sourceRequests.slice(start);
      expect(issued.length).toBeGreaterThan(0);
      expect(issued.every(request => request.principal === principal && request.completed)).toBe(true);
      expect(issued.every(request => request.query.includes("'MASKED'"))).toBe(principal === 'analyst');
    }
  });

  test('revoking the credential denies the query before source dispatch', async () => {
    const start = endpoint.sourceRequests.length;
    grants.delete('analyst');

    try {
      const denied = await endpoint.request(sql('ASC', 'LAST'), 'analyst');
      expect(denied.status).toBe(403);
      expect(endpoint.sourceRequests).toHaveLength(start);
    } finally {
      grants.set('analyst', ['analyst']);
    }
  });

  test.each([
    { kind: 'default', sql: undefined },
    { kind: 'typed SQL', sql: 'CAST(NULL AS text)' }
  ])('$kind NULL mask retains the member slot and valid selected-column ordering', async fixture => {
    maskSQL = fixture.sql;
    revision++;

    try {
      const start = endpoint.sourceRequests.length;
      const result = await endpoint.execute(sql('ASC', 'LAST'), 'analyst');
      expect(amounts(result.rows)).toEqual([['north', null, 30]]);
      expect(result.messages.find(message => message.schema)?.schema).toEqual([
        { name: 'region', column_type: 'String' },
        { name: 'channel', column_type: 'String' },
        { name: 'total_amount', column_type: 'Double' }
      ]);
      const issued = endpoint.sourceRequests.slice(start);
      expect(issued.length).toBeGreaterThan(0);
      expect(issued.every(request => request.completed && request.principal === 'analyst' &&
        request.values.includes('north') && /ORDER BY\s+1 ASC NULLS LAST,\s*2 ASC NULLS LAST/.test(request.query))).toBe(true);
      console.log('NULL mask source capture', JSON.stringify({ rows: result.rows, sourceRequests: issued }));
    } finally {
      maskSQL = "'MASKED'";
      revision++;
    }
  });
});

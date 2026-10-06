import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { PostgresDriver } from '@cubejs-backend/postgres-driver';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

const setupSQL = `
  CREATE TABLE orders(id BIGINT, region VARCHAR, total DECIMAL(38,2), observed_day DATE);
  INSERT INTO orders VALUES (1, 'A', 10, DATE '1992-01-01'), (2, 'A', 20, DATE '1992-01-01'), (3, 'B', 30, DATE '1992-02-01'), (4, NULL, 40, NULL);
  CREATE TABLE lineitems(id BIGINT, order_id BIGINT, kind VARCHAR, amount DECIMAL(38,2));
  INSERT INTO lineitems VALUES (1,1,'paid',1), (2,1,'refund',2), (3,3,'paid',4), (4,3,'paid',5);`;
const model = `
  cube('orders', {
    sql: 'SELECT * FROM orders',
    joins: { lineitems: { sql: \`\${CUBE}.id = \${lineitems}.order_id\`, relationship: 'one_to_many' } },
    dimensions: { id: { sql: 'id', type: 'number', primary_key: true, public: true }, region: { sql: 'region', type: 'string' }, observed_day: { sql: 'observed_day', type: 'time' } },
    measures: { total: { sql: 'total', type: 'sum', meta: { result_semantics: { numeric: { kind: 'decimal', precision: 38, scale: 2, arithmetic: 'exact' } } } }, filtered_total: { sql: 'total', type: 'sum', filters: [{ sql: \`\${CUBE}.region = 'A'\` }], meta: { result_semantics: { numeric: { kind: 'decimal', precision: 38, scale: 2, arithmetic: 'exact' } } } } },
    access_policy: [{ group: 'reader', member_level: { includes: '*' } }]
  });
  cube('compound_orders', {
    sql: 'SELECT * FROM orders',
    joins: { lineitems: { sql: \`\${CUBE}.id = \${lineitems}.order_id\`, relationship: 'one_to_many' } },
    dimensions: { id: { sql: 'id', type: 'number', primary_key: true, public: true }, region_key: { sql: 'region', type: 'string', primary_key: true, public: true }, region: { sql: 'region', type: 'string' } },
    measures: { total: { sql: 'total', type: 'sum', meta: { result_semantics: { numeric: { kind: 'decimal', precision: 38, scale: 2, arithmetic: 'exact' } } } } },
    access_policy: [{ group: 'reader', member_level: { includes: '*' } }]
  });
  cube('lineitems', {
    sql: 'SELECT * FROM lineitems',
    dimensions: { id: { sql: 'id', type: 'number', primary_key: true, public: true }, order_id: { sql: 'order_id', type: 'number', public: true }, kind: { sql: 'kind', type: 'string' } },
    measures: { low: { sql: 'amount', type: 'min', meta: { result_semantics: { numeric: { kind: 'decimal', precision: 38, scale: 2, arithmetic: 'exact' } } } }, high: { sql: 'amount', type: 'max', meta: { result_semantics: { numeric: { kind: 'decimal', precision: 38, scale: 2, arithmetic: 'exact' } } } }, count: { type: 'count' }, amount: { sql: 'amount', type: 'sum', meta: { result_semantics: { numeric: { kind: 'decimal', precision: 38, scale: 2, arithmetic: 'exact' } } } } },
    access_policy: [{ group: 'reader', member_level: { includes: '*' } }]
  });`;
const from = 'FROM orders LEFT JOIN lineitems ON orders.__cubeJoinField = lineitems.__cubeJoinField';

describe('Aggregate identity keys with root-only and right-side dependencies', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  beforeAll(async () => {
    endpoint = await startSemanticSqlEndpoint({
      model: () => model,
      setupSQL,
      streamMode: true,
      grants: new Map([['reader', ['reader']]])
    });
  });
  afterAll(async () => { await endpoint?.stop(); });

  const independentWireTest = process.env.QUERYRAILS_APPLICATION_ROOT && process.env.DATABASES_DIRECT_URL ? test : test.skip;
  independentWireTest('separately reads Cube operands through signed source-free Fleet against PostgreSQL truth', async () => {
    const applicationRoot = process.env.QUERYRAILS_APPLICATION_ROOT!;
    // Load the application's actual environment default outside Jest's CJS
    // transform rather than copying its fallback constant into this fixture.
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      "import { resolveQueryMaxRows } from './packages/config/dist/row-limit.js'; process.stdout.write(String(resolveQueryMaxRows(process.env.QUERY_MAX_ROWS)))"],
    { cwd: applicationRoot, timeout: 10000, maxBuffer: 1024 });
    const transferCeiling = Number(stdout);
    const additionalRows = transferCeiling + 10000;
    // Bound this owned probe's source-generation cost without changing any
    // product row limit. A larger environment needs its own measured fixture.
    if (additionalRows > 150000) throw new Error('Owned leaf-state fixture exceeds its source-generation budget');
    const lastLineId = 13 + additionalRows;
    const directory = mkdtempSync(join(tmpdir(), 'qr-independent-operands-native-'));
    const packetPath = join(directory, 'candidate.json');
    const capturePath = join(directory, 'capture.json');
    const url = new URL(process.env.DATABASES_DIRECT_URL!);
    url.pathname = '/tpc_h';
    const source = new PostgresDriver({
      connectionString: url.toString(),
      readOnly: true,
      maxPoolSize: 1,
      options: '-c default_transaction_read_only=on -c statement_timeout=30000',
      executionTimeout: 30
    });
    // Same typed observations, independently authored on read-only PostgreSQL.
    // Only the owned in-memory serving fixture is mutated below.
    const observations = `WITH orders(id, region, total) AS (VALUES
      (1,'A',10::numeric(38,2)),(2,'A',20::numeric(38,2)),(3,'B',30::numeric(38,2)),(4,NULL,40::numeric(38,2)),
      (5,'A',10::numeric(38,2)),(6,'A',9007199254740993.12::numeric(38,2)),(7,'C',5::numeric(38,2))),
    lineitems(id, order_id, kind, amount) AS ((VALUES
      (1,1,'paid',1::numeric(38,2)),(2,1,'refund',2::numeric(38,2)),(3,3,'paid',4::numeric(38,2)),(4,3,'paid',5::numeric(38,2)),
      (5,5,'paid',7::numeric(38,2)),(6,5,'paid',8::numeric(38,2)),(7,6,'paid',3::numeric(38,2)),(8,6,'paid',4::numeric(38,2)),
      (9,2,NULL,5::numeric(38,2)),(10,999,NULL,99::numeric(38,2)),(11,NULL,NULL,90::numeric(38,2)),
      (12,7,'null-value',NULL::numeric(38,2)),(13,7,'large-value',9007199254740993.12::numeric(38,2)))
      UNION ALL SELECT i,1,'paid',0::numeric(38,2) FROM generate_series(14,${lastLineId}) i)`;
    const definitions = [
      {
        id: 'root-filter',
        predicate: "o.region='A'",
        filters: [{ member: 'orders.region', operator: 'equals', values: ['A'] }],
        expected: [['9007199254741033.12', '30.00', String(additionalRows + 7), '0.00', '8.00']],
        inputRows: [4, 8]
      },
      {
        id: 'optional-null',
        predicate: 'l.kind IS NULL',
        filters: [{ member: 'lineitems.kind', operator: 'notSet' }],
        expected: [['60.00', '5.00', '1', '5.00', '5.00']],
        inputRows: [7, 10]
      },
      {
        id: 'cross-operand-or',
        predicate: "o.region='B' OR l.kind='refund'",
        filters: [{ or: [
          { member: 'orders.region', operator: 'equals', values: ['B'] },
          { member: 'lineitems.kind', operator: 'equals', values: ['refund'] }
        ] }],
        expected: [['40.00', '11.00', '3', '2.00', '5.00']],
        inputRows: [7, 10]
      },
      {
        id: 'matched-all-null',
        predicate: "l.kind='null-value'",
        filters: [{ member: 'lineitems.kind', operator: 'equals', values: ['null-value'] }],
        expected: [['5.00', null, '1', null, null]],
        inputRows: [7, 10]
      },
      {
        id: 'large-exact-extrema',
        predicate: "l.kind='large-value'",
        filters: [{ member: 'lineitems.kind', operator: 'equals', values: ['large-value'] }],
        expected: [['5.00', '9007199254740993.12', '1', '9007199254740993.12', '9007199254740993.12']],
        inputRows: [7, 10]
      },
      {
        id: 'unmatched-root',
        predicate: 'o.id=4',
        filters: [{ member: 'orders.id', operator: 'equals', values: ['4'] }],
        expected: [['40.00', null, '0', null, null]],
        inputRows: [1, 8]
      },
      {
        id: 'empty-root',
        predicate: 'o.id=998',
        filters: [{ member: 'orders.id', operator: 'equals', values: ['998'] }],
        expected: [[null, null, '0', null, null]],
        inputRows: [0, 8]
      }
    ];
    const cases: unknown[] = [];
    const references: unknown[] = [];

    try {
      await endpoint.connection.run(`INSERT INTO orders VALUES (5,'A',10,DATE '1992-01-01'),(6,'A',9007199254740993.12,DATE '1992-01-01'),(7,'C',5,DATE '1992-01-01');
        INSERT INTO lineitems VALUES (5,5,'paid',7),(6,5,'paid',8),(7,6,'paid',3),(8,6,'paid',4),(9,2,NULL,5),(10,999,NULL,99),(11,NULL,NULL,90),(12,7,'null-value',NULL),(13,7,'large-value',9007199254740993.12);
        INSERT INTO lineitems SELECT i,1,'paid',0 FROM range(14,${lastLineId + 1}) t(i)`);
      const rawSourceRows = Number((await endpoint.connection.runAndReadAll('SELECT COUNT(*) AS count FROM lineitems')).getRows()[0][0]);
      expect(rawSourceRows).toBe(additionalRows + 13);
      expect(rawSourceRows).toBeGreaterThan(transferCeiling);
      const metadataResponse = await fetch(endpoint.url.replace(/\/cubesql$/, '/meta?extended'), { headers: { Authorization: 'reader' } });
      expect(metadataResponse.status).toBe(200);
      const meta = await metadataResponse.json();
      const referenceRows = async (sql: string) => (await source.query<{ total: string | null; amount: string | null; count: string; low: string | null; high: string | null }>(sql, []))
        .map(row => [row.total, row.amount, row.count, row.low, row.high]);

      for (const definition of definitions) {
        const referenceSql = `${observations}, population AS MATERIALIZED (
          SELECT o.id, o.total, l.id AS line_id, l.amount FROM orders o LEFT JOIN lineitems l ON l.order_id=o.id
          WHERE ${definition.predicate}),
        orders_state AS (SELECT sum(total)::numeric(38,2) AS total FROM (SELECT DISTINCT id,total FROM population) p),
        lines_state AS (SELECT sum(amount)::numeric(38,2) AS amount,count(*) AS count,min(amount)::numeric(38,2) AS low,max(amount)::numeric(38,2) AS high FROM (SELECT DISTINCT line_id,amount FROM population WHERE line_id IS NOT NULL) p)
        SELECT o.total::text AS total,l.amount::text AS amount,l.count::text AS count,l.low::text AS low,l.high::text AS high FROM orders_state o CROSS JOIN lines_state l`;
        const expected = await referenceRows(referenceSql);
        expect(expected).toEqual(definition.expected);
        const query = `SELECT MEASURE(orders.total) AS "orders.total", MEASURE(lineitems.amount) AS "lineitems.amount", MEASURE(lineitems.count) AS "lineitems.count", MEASURE(lineitems.low) AS "lineitems.low", MEASURE(lineitems.high) AS "lineitems.high" ${from} WHERE ${definition.predicate.replace(/\bo\./g, 'orders.').replace(/\bl\./g, 'lineitems.')}`;
        const whole = await endpoint.execute(query, 'reader');
        expect(whole.rows).toEqual(expected);
        references.push({ id: definition.id, sql: referenceSql, rows: expected, wholeCubeQuery: query, wholeCubeRows: whole.rows });
        if (definition.id === 'root-filter') {
          const mutations = [
            referenceSql.replace('SELECT DISTINCT id,total FROM population', 'SELECT id,total FROM population'),
            referenceSql.replace('sum(total)', 'sum(DISTINCT total)'),
            referenceSql.replace('min(amount)', 'sum(amount)'),
            referenceSql.replace('max(amount)', 'sum(amount)')
          ];

          for (const sql of mutations) {
            const rows = await referenceRows(sql);
            expect(rows).not.toEqual(expected);
            references.push({ mutation: true, sql, rows });
          }
        }
        if (definition.id === 'matched-all-null' || definition.id === 'unmatched-root') {
          // NULL aggregate state is not zero, and the null-extended LEFT row
          // is not an observed child entity. Both mistakes must be detectable.
          const sql = definition.id === 'matched-all-null'
            ? referenceSql.replace('l.low::text AS low', 'coalesce(l.low,0)::numeric(38,2)::text AS low')
            : referenceSql.replace(' WHERE line_id IS NOT NULL', '');
          const rows = await referenceRows(sql);
          expect(rows).not.toEqual(expected);
          references.push({ mutation: true, caseId: definition.id, sql, rows });
        }
        cases.push({
          id: definition.id,
          query: { rootCube: 'orders', dimensions: [], measures: ['orders.total', 'lineitems.amount', 'lineitems.count', 'lineitems.low', 'lineitems.high'], filters: definition.filters },
          expected,
          inputRows: definition.inputRows
        });
      }
      const fixtureSha256 = createHash('sha256').update(model + setupSQL + observations).digest('hex');
      writeFileSync(packetPath, JSON.stringify({
        fixtureSha256,
        rawSourceRows,
        transferCeiling,
        meta,
        cases,
        facts: {
          operands: [
            { cube: 'orders', identity: ['orders.id'], dimensions: ['orders.id', 'orders.region'], measures: [{ member: 'orders.total', combine: 'sum' }] },
            { cube: 'lineitems', identity: ['lineitems.id'], dimensions: ['lineitems.id', 'lineitems.order_id', 'lineitems.kind'], measures: [{ member: 'lineitems.amount', combine: 'sum' }, { member: 'lineitems.count', combine: 'sum', emptyValue: 0 }, { member: 'lineitems.low', combine: 'min' }, { member: 'lineitems.high', combine: 'max' }] }
          ],
          joins: [{ from: 'orders', to: 'lineitems', keys: [{ left: 'orders.id', right: 'lineitems.order_id' }] }]
        }
      }));
      const cursor = endpoint.sourceRequests.length;
      await promisify(execFile)(process.execPath, [join(applicationRoot, 'apps/api/node_modules/vitest/vitest.mjs'), 'run',
        'src/test/semantic-parity-integration/semantic-operand-fleet-wire.integration.test.ts'], {
        cwd: join(applicationRoot, 'apps/api'),
        timeout: 60000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, QUERYRAILS_OPERAND_CUBE_URL: endpoint.url, QUERYRAILS_OPERAND_PACKET_PATH: packetPath, QUERYRAILS_OPERAND_CAPTURE_PATH: capturePath }
      }).catch((error: Error & { stdout?: string }) => {
        if (error.stdout) console.log('Owned operand child diagnostics', error.stdout);
        throw error;
      });
      const capture = JSON.parse(readFileSync(capturePath, 'utf8'));
      const requests = endpoint.sourceRequests.slice(cursor);
      expect(requests).toHaveLength(definitions.length * 2 + 1);
      expect(requests.every(request => request.principal === 'reader' && request.completed && request.streamed)).toBe(true);
      expect(capture.cases).toHaveLength(definitions.length);
      const evidence = { fixtureSha256, rawSourceRows, transferCeiling, references, sourceRequests: requests, wire: capture };
      console.log('Native independent semantic operand capture', JSON.stringify(evidence));
      if (process.env.QUERYRAILS_OPERAND_NATIVE_CAPTURE_PATH) writeFileSync(process.env.QUERYRAILS_OPERAND_NATIVE_CAPTURE_PATH, `${JSON.stringify(evidence)}\n`);
    } finally {
      await source.release();
      await endpoint.connection.run(`DELETE FROM lineitems WHERE id BETWEEN 5 AND ${lastLineId}; DELETE FROM orders WHERE id IN (5,6,7)`);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('reports native calendar-date and exact decimal output contracts including a NULL group', async () => {
    const actual = await endpoint.execute(`SELECT CAST(orders.observed_day AS DATE) AS day,
      MEASURE(orders.total) AS total FROM orders GROUP BY 1 ORDER BY 1 NULLS LAST`, 'reader');
    expect(actual.rows).toEqual([['1992-01-01', '30.00'], ['1992-02-01', '30.00'], [null, '40.00']]);
    expect(actual.messages.find(message => message.schema)?.schema).toEqual([
      { name: 'day', column_type: 'Date32' }, { name: 'total', column_type: 'Decimal(38, 2)' }
    ]);
  });

  test.each([
    { id: 'root-only grouping retains unmatched identities and a NULL group',
      query: `SELECT orders.region AS region, MEASURE(orders.total) AS order_total, MEASURE(lineitems.amount) AS line_amount ${from} GROUP BY 1 ORDER BY 1 NULLS LAST`,
      reference: `WITH a AS (SELECT region, sum(total) AS total FROM orders GROUP BY region),
        b AS (SELECT o.region, sum(l.amount) AS amount FROM orders o JOIN lineitems l ON l.order_id=o.id GROUP BY o.region)
        SELECT a.region, a.total::VARCHAR, b.amount::VARCHAR FROM a LEFT JOIN b ON a.region IS NOT DISTINCT FROM b.region ORDER BY a.region NULLS LAST`,
      expected: [['A', '30.00', '3.00'], ['B', '30.00', '9.00'], [null, '40.00', null]],
      needsRightKeys: false },
    { id: 'right-side row predicate preserves the selected joined population',
      query: `SELECT orders.region AS region, MEASURE(orders.total) AS order_total, MEASURE(lineitems.amount) AS line_amount ${from} WHERE lineitems.kind = 'paid' GROUP BY 1 ORDER BY 1 NULLS LAST`,
      reference: `WITH selected AS (SELECT id, region, total FROM orders WHERE EXISTS (SELECT 1 FROM lineitems l WHERE l.order_id=orders.id AND l.kind='paid')),
        a AS (SELECT region, sum(total) AS total FROM selected GROUP BY region),
        b AS (SELECT o.region, sum(l.amount) AS amount FROM orders o JOIN lineitems l ON l.order_id=o.id WHERE l.kind='paid' GROUP BY o.region)
        SELECT a.region, a.total::VARCHAR, b.amount::VARCHAR FROM a JOIN b ON a.region IS NOT DISTINCT FROM b.region ORDER BY a.region NULLS LAST`,
      expected: [['A', '10.00', '1.00'], ['B', '30.00', '9.00']],
      needsRightKeys: true },
    { id: 'right-side grouping keeps one identity per attributed group',
      query: `SELECT lineitems.kind AS kind, MEASURE(orders.total) AS order_total, MEASURE(lineitems.amount) AS line_amount ${from} GROUP BY 1 ORDER BY 1 NULLS LAST`,
      reference: `WITH membership AS (SELECT DISTINCT o.id, o.total, l.kind FROM orders o LEFT JOIN lineitems l ON l.order_id=o.id),
        a AS (SELECT kind, sum(total) AS total FROM membership GROUP BY kind),
        b AS (SELECT kind, sum(amount) AS amount FROM lineitems GROUP BY kind)
        SELECT a.kind, a.total::VARCHAR, b.amount::VARCHAR FROM a LEFT JOIN b ON a.kind IS NOT DISTINCT FROM b.kind ORDER BY a.kind NULLS LAST`,
      expected: [['paid', '40.00', '10.00'], ['refund', '10.00', '2.00'], [null, '60.00', null]],
      needsRightKeys: true },
  ])('$id', async fixture => {
    const reference = (await endpoint.connection.runAndReadAll(fixture.reference)).getRows();
    expect(reference).toEqual(fixture.expected);
    const cursor = endpoint.sourceRequests.length;
    const actual = await endpoint.execute(fixture.query, 'reader');
    expect(actual.rows).toEqual(reference);
    const requests = endpoint.sourceRequests.slice(cursor);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ principal: 'reader', completed: true, streamed: true });
    // Carry the value without changing which identity/group pairs survive.
    if (fixture.needsRightKeys) expect(requests[0].query).toContain('orders_key_lineitems');
    else expect(requests[0].query).not.toContain('orders_key_lineitems');
    console.log('Native root-sum identity capture', JSON.stringify({
      fixture: fixture.id,
      query: requests[0].query,
      rows: actual.rows,
      completed: requests[0].completed
    }));
    expect(requests[0].query.match(/\b(?:FROM|JOIN)\s+"?orders"?\s+AS/g)).toHaveLength(2);
  });
  test('equal amounts on distinct identities contribute separately', async () => {
    try {
      await endpoint.connection.run(`INSERT INTO orders VALUES (5,'A',10,DATE '1992-01-01');
        INSERT INTO lineitems VALUES (5,5,'paid',7), (6,5,'paid',8)`);
      const reference = (await endpoint.connection.runAndReadAll(
        `SELECT region, sum(total)::VARCHAR FROM orders GROUP BY region ORDER BY region NULLS LAST`
      )).getRows();
      const actual = await endpoint.execute(`SELECT orders.region AS region,
        MEASURE(orders.total) AS total, MEASURE(lineitems.amount) AS amount ${from}
        GROUP BY 1 ORDER BY 1 NULLS LAST`, 'reader');
      expect(actual.rows.map(row => row.slice(0, 2))).toEqual(reference);
      expect(actual.rows[0]).toEqual(['A', '40.00', '18.00']);
    } finally { await endpoint.connection.run('DELETE FROM lineitems WHERE id IN (5,6); DELETE FROM orders WHERE id=5'); }
  });

  test('a NULL identity retains its group without acquiring a lookup value', async () => {
    try {
      await endpoint.connection.run(`INSERT INTO orders VALUES (NULL,'NULL_KEY',99,NULL)`);
      // Ordinary equality cannot retrieve a value for the NULL key. Keep the
      // group, matching the original lookup, rather than dropping that row.
      const reference = (await endpoint.connection.runAndReadAll(
        `SELECT region, sum(CASE WHEN id IS NOT NULL THEN total END)::VARCHAR
          FROM orders GROUP BY region ORDER BY region NULLS LAST`
      )).getRows();
      const actual = await endpoint.execute(`SELECT orders.region AS region,
        MEASURE(orders.total) AS total, MEASURE(lineitems.amount) AS amount ${from}
        GROUP BY 1 ORDER BY 1 NULLS LAST`, 'reader');
      expect(actual.rows.map(row => row.slice(0, 2))).toEqual(reference);
      expect(actual.rows).toContainEqual(['NULL_KEY', null, null]);
    } finally { await endpoint.connection.run('DELETE FROM orders WHERE id IS NULL'); }
  });

  test('an empty selected population stays empty', async () => {
    const actual = await endpoint.execute(`SELECT orders.region AS region,
      MEASURE(orders.total) AS total, MEASURE(lineitems.amount) AS amount ${from}
      WHERE orders.region = 'absent' GROUP BY 1 ORDER BY 1 NULLS LAST`, 'reader');
    expect(actual.rows).toEqual([]);
  });

  test('a filtered measure retains the existing value-lookup path', async () => {
    const cursor = endpoint.sourceRequests.length;
    const actual = await endpoint.execute(`SELECT orders.region AS region,
      MEASURE(orders.filtered_total) AS total, MEASURE(lineitems.amount) AS amount ${from}
      GROUP BY 1 ORDER BY 1 NULLS LAST`, 'reader');
    const reference = (await endpoint.connection.runAndReadAll(
      `SELECT region, sum(total) FILTER (WHERE region='A')::VARCHAR
        FROM orders GROUP BY region ORDER BY region NULLS LAST`
    )).getRows();
    expect(actual.rows.map(row => row.slice(0, 2))).toEqual(reference);
    expect(endpoint.sourceRequests.slice(cursor)[0].query.match(/\b(?:FROM|JOIN)\s+"?orders"?\s+AS/g)).toHaveLength(3);
  });

  test('a partially NULL composite identity keeps the ordinary equality semantics', async () => {
    const reference = (await endpoint.connection.runAndReadAll(
      `SELECT region, sum(CASE WHEN id IS NOT NULL AND region IS NOT NULL THEN total END)::VARCHAR
        FROM orders GROUP BY region ORDER BY region NULLS LAST`
    )).getRows();
    const actual = await endpoint.execute(`SELECT compound_orders.region AS region,
      MEASURE(compound_orders.total) AS total, MEASURE(lineitems.amount) AS amount
      FROM compound_orders LEFT JOIN lineitems ON compound_orders.__cubeJoinField = lineitems.__cubeJoinField
      GROUP BY 1 ORDER BY 1 NULLS LAST`, 'reader');
    expect(actual.rows.map(row => row.slice(0, 2))).toEqual(reference);
    expect(actual.rows).toContainEqual([null, null, null]);
  });

  test('carried values retain exact decimals beyond the JavaScript safe-integer range', async () => {
    try {
      await endpoint.connection.run(`INSERT INTO orders VALUES (6,'A',9007199254740993.12,DATE '1992-01-01'),(7,'C',5,DATE '1992-01-01');
        INSERT INTO lineitems VALUES (7,6,'paid',3), (8,6,'paid',4)`);
      const reference = (await endpoint.connection.runAndReadAll(
        `SELECT region, sum(total)::VARCHAR FROM orders GROUP BY region ORDER BY region NULLS LAST`
      )).getRows();
      const actual = await endpoint.execute(`SELECT orders.region AS region,
        MEASURE(orders.total) AS total, MEASURE(lineitems.amount) AS amount ${from}
        GROUP BY 1 ORDER BY 1 NULLS LAST`, 'reader');
      expect(actual.rows.map(row => row.slice(0, 2))).toEqual(reference);
      expect(actual.rows[0]).toEqual(['A', '9007199254741023.12', '10.00']);
    } finally { await endpoint.connection.run('DELETE FROM lineitems WHERE id IN (7,8); DELETE FROM orders WHERE id=6'); }
  });
});

interface GroupedModelSpec {
  name: string;
  columns: Array<{ name: string; dataType: string; isNullable: boolean }>;
  states: Array<{ name: string; type: string; column?: string; scale?: number }>;
}
const groupedSpecs: GroupedModelSpec[] = [
  { name: 'root_entries',
    columns: [
      { name: 'id', dataType: 'integer', isNullable: false }, { name: 'tag_key', dataType: 'integer', isNullable: true },
      { name: 'kind', dataType: 'varchar', isNullable: true }, { name: 'amount', dataType: 'decimal(38,9)', isNullable: true }
    ],
    states: [{ name: 'total', type: 'sum', column: 'amount', scale: 9 }, { name: 'count', type: 'count' }] },
  { name: 'parents',
    columns: [
      { name: 'id', dataType: 'integer', isNullable: false }, { name: 'amount', dataType: 'decimal(38,2)', isNullable: true }
    ],
    states: [{ name: 'total', type: 'sum', column: 'amount', scale: 2 }, { name: 'count', type: 'count' }] },
  { name: 'bridge_entries',
    columns: [
      { name: 'id', dataType: 'integer', isNullable: false }, { name: 'parent_id', dataType: 'integer', isNullable: true },
      { name: 'tag_key', dataType: 'integer', isNullable: true }
    ],
    states: [{ name: 'count', type: 'count' }] },
  { name: 'tags',
    columns: [
      { name: 'id', dataType: 'integer', isNullable: false }, { name: 'label', dataType: 'varchar', isNullable: true }
    ],
    states: [{ name: 'count', type: 'count' }] }
];
const groupedDeclared = [
  { from: 'root_entries', to: 'tags', type: 'left', cardinality: 'many_to_one', keys: [{ left: 'tag_key', right: 'id' }] },
  { from: 'parents', to: 'bridge_entries', type: 'left', cardinality: 'one_to_many', keys: [{ left: 'id', right: 'parent_id' }] },
  { from: 'bridge_entries', to: 'tags', type: 'left', cardinality: 'many_to_one', keys: [{ left: 'tag_key', right: 'id' }] }
];
const ownGroupedColumn = (name: string) => `\${CUBE}."${name}"`;
const groupedJoinSql = (edge: typeof groupedDeclared[number]) => `${ownGroupedColumn(edge.keys[0].left)} = \${${edge.to}}."${edge.keys[0].right}"`;
// Current database rows are explicit fixture ports, built from the same owned
// published definitions as the model. The server binder consumes these rows
// and the actual native metadata; it does not consume expected operand facts.
const groupedCatalogModels = groupedSpecs.map(spec => {
  const tenantId = 'grouped-producer'; const tableId = `table-${spec.name}`;
  const dataSourceId = `source-${spec.name}`; const schemaId = `schema-${spec.name}`;
  return { id: `model-${spec.name}`,
    name: spec.name,
    tenantId,
    dataSourceId,
    tableSchemaId: tableId,
    dataSourceType: 'table',
    dimensions: spec.columns.filter(column => column.name !== 'amount').map(column => ({
      id: `${spec.name}-${column.name}`,
      name: column.name,
      type: column.dataType === 'varchar' ? 'string' : 'number',
      sql: ownGroupedColumn(column.name),
      primaryKey: column.name === 'id',
      subQuery: false,
      publishStatus: 'published',
      orphaned: false
    })),
    measures: spec.states.map(state => ({ id: `${spec.name}-${state.name}`,
      name: state.name,
      type: state.type,
      sql: state.column ? ownGroupedColumn(state.column) : null,
      multiStage: false,
      timeShift: null,
      caseConfig: null,
      filters: null,
      summarizability: null,
      publishStatus: 'published',
      orphaned: false })),
    tableSchema: { id: tableId,
      tenantId,
      type: 'table',
      active: true,
      deletedAt: null,
      databaseSchemaId: schemaId,
      schema: 'main',
      name: spec.name,
      databaseSchema: { id: schemaId, dataSourceId, name: 'main', tenantId, deletedAt: null },
      columns: spec.columns.map(column => ({ ...column, collationDeterministic: column.dataType === 'varchar' ? true : null })),
      constraints: [{ id: `pk-${spec.name}`,
        type: 'PRIMARY KEY',
        origin: 'declared',
        active: true,
        tableId,
        typedColumns: [{ ordinalPosition: 1, childColumn: { name: 'id', tableId, tenantId, deletedAt: null } }] }] }
  };
});
const groupedCatalogJoins = groupedDeclared.map(edge => ({ id: `join-${edge.from}-${edge.to}`,
  status: 'confirmed',
  relationship: edge.cardinality,
  sql: groupedJoinSql(edge),
  fromOccurrence: { occurrenceId: edge.from },
  toOccurrence: { occurrenceId: edge.to },
  keyColumns: edge.keys.map((key, ordinalPosition) => ({ ordinalPosition, childColumn: key.left, parentColumn: key.right }))
}));
const groupedModel = groupedCatalogModels.map((definition, index) => {
  const dimensions = definition.dimensions.map(dimension => {
    const options = { type: dimension.type, primary_key: dimension.primaryKey, public: true, meta: { member_id: dimension.id } };
    return `${JSON.stringify(dimension.name)}: { sql: (CUBE) => CUBE + ${JSON.stringify(`."${dimension.name}"`)}, ${JSON.stringify(options).slice(1, -1)} }`;
  });
  const measures = groupedSpecs[index].states.map(state => {
    const options = { type: state.type,
      public: true,
      meta: { member_id: `${definition.name}-${state.name}`,
        staged: false,
        rolling: false,
        time_shifted: false,
        ...(state.scale === undefined ? {} : { result_semantics: { numeric: { kind: 'decimal', precision: 38, scale: state.scale, arithmetic: 'exact' } } }) } };
    const sql = state.column ? `sql: (CUBE) => CUBE + ${JSON.stringify(`."${state.column}"`)}, ` : '';
    return `${JSON.stringify(state.name)}: { ${sql}${JSON.stringify(options).slice(1, -1)} }`;
  });
  const joins = groupedDeclared.filter(edge => edge.from === definition.name).map(edge => `${JSON.stringify(edge.to)
  }: { sql: (CUBE, ${edge.to}) => \`${groupedJoinSql(edge)}\`, relationship: ${JSON.stringify(edge.cardinality)} }`);
  const sql = `SELECT * FROM "grouped"."main"."${definition.name}"`;
  return `cube(${JSON.stringify(definition.name)}, { sql: () => ${JSON.stringify(sql)
  }, meta: ${JSON.stringify({ id: definition.id, tenantId: definition.tenantId })
  }, dimensions: { ${dimensions.join(', ')} }, measures: { ${measures.join(', ')} }, joins: { ${joins.join(', ')
  } }, access_policy: [{ group: "reader", member_level: { includes: "*" } }] });`;
}).join('\n');

// Extends the existing independent operand workflow. Reader/catalog rows remain
// fixtures; current operand facts bind against actual native extended metadata
// before the ordinary state reads and Fleet wire.
describe('Grouped root and bridge native semantic state', () => {
  jest.setTimeout(60000);
  const enabled = process.env.QUERYRAILS_APPLICATION_ROOT && process.env.DATABASES_DIRECT_URL && process.env.QUERYRAILS_GROUPED_OPERAND_ORACLE_PATH;
  const independentStateTest = enabled ? test : test.skip;
  independentStateTest('preserves large root/bridge populations with complete bounded Cube reads', async () => {
    const applicationRoot = process.env.QUERYRAILS_APPLICATION_ROOT!;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      "import { resolveQueryMaxRows } from './packages/config/dist/row-limit.js'; process.stdout.write(String(resolveQueryMaxRows(process.env.QUERY_MAX_ROWS)))"],
    { cwd: applicationRoot, timeout: 10000, maxBuffer: 1024 });
    const transferCeiling = Number(stdout);
    const rows = transferCeiling + 30000;
    if (rows > 150000) throw new Error('Owned grouped-state fixture exceeds its source-generation budget');
    const oracle = JSON.parse(readFileSync(process.env.QUERYRAILS_GROUPED_OPERAND_ORACLE_PATH!, 'utf8')) as {
      cases: Array<{ name: string; sql: string }>;
    };
    const setup = `SET threads=1; ATTACH ':memory:' AS grouped;
      CREATE TABLE grouped.main.root_entries(id INTEGER PRIMARY KEY,tag_key INTEGER,kind VARCHAR,amount DECIMAL(38,9));
      INSERT INTO grouped.main.root_entries SELECT i,CASE i%4 WHEN 0 THEN NULL WHEN 1 THEN 1 WHEN 2 THEN 2 ELSE 999 END,
        CASE WHEN i%3=0 THEN 'void' ELSE 'paid' END,
        CASE WHEN i%7=0 THEN NULL ELSE 9007199254740993.123456789::DECIMAL(38,9) END FROM range(1,${rows + 1}) t(i);
      CREATE TABLE grouped.main.parents(id INTEGER PRIMARY KEY,amount DECIMAL(38,2)); INSERT INTO grouped.main.parents VALUES (1,10),(2,10),(3,NULL);
      CREATE TABLE grouped.main.bridge_entries(id INTEGER PRIMARY KEY,parent_id INTEGER,tag_key INTEGER);
      INSERT INTO grouped.main.bridge_entries SELECT i,CASE i%4 WHEN 0 THEN NULL WHEN 1 THEN 1 WHEN 2 THEN 2 ELSE 999 END,
        CASE i%3 WHEN 0 THEN NULL WHEN 1 THEN 1 ELSE 2 END FROM range(1,${rows + 1}) t(i);
      CREATE TABLE grouped.main.tags(id INTEGER PRIMARY KEY,label VARCHAR); INSERT INTO grouped.main.tags VALUES (1,'A'),(2,NULL),(3,'B');`;
    const url = new URL(process.env.DATABASES_DIRECT_URL!); url.pathname = '/tpc_h';
    const source = new PostgresDriver({ connectionString: url.toString(),
      readOnly: true,
      maxPoolSize: 1,
      options: '-c default_transaction_read_only=on -c statement_timeout=30000',
      executionTimeout: 30 });
    const directory = mkdtempSync(join(tmpdir(), 'qr-grouped-operands-native-'));
    const packetPath = join(directory, 'candidate.json'); const capturePath = join(directory, 'capture.json');
    let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>> | undefined;

    try {
      endpoint = await startSemanticSqlEndpoint({ model: () => groupedModel, setupSQL: setup, streamMode: true, grants: new Map([['reader', ['reader']]]) });
      const metadataResponse = await fetch(endpoint.url.replace(/\/cubesql$/, '/meta?extended'), { headers: { Authorization: 'reader' } });
      expect(metadataResponse.status).toBe(200); const meta = await metadataResponse.json();
      const references: unknown[] = [];
      const definitions = [
        { name: 'root', filters: [], inputRows: [4, 3], predicate: '' },
        { name: 'root_optional_null', filters: [{ member: 'tags.label', operator: 'notSet' }], inputRows: [4, 3], predicate: 'WHERE tags.label IS NULL' },
        { name: 'root_cross_or', filters: [{ or: [{ member: 'root_entries.kind', operator: 'equals', values: ['void'] }, { member: 'tags.label', operator: 'equals', values: ['A'] }] }], inputRows: [8, 3], predicate: "WHERE root_entries.kind='void' OR tags.label='A'" },
      ];
      const rootFacts = { operands: [
        { cube: 'root_entries', identity: ['root_entries.id'], dimensions: ['root_entries.id', 'root_entries.tag_key', 'root_entries.kind'], measures: [{ member: 'root_entries.total', combine: 'sum' }, { member: 'root_entries.count', combine: 'sum', emptyValue: 0 }] },
        { cube: 'tags', identity: ['tags.id'], dimensions: ['tags.id', 'tags.label'], measures: [{ member: 'tags.count', combine: 'sum', emptyValue: 0 }] },
      ],
      joins: [{ from: 'root_entries', to: 'tags', keys: [{ left: 'root_entries.tag_key', right: 'tags.id' }] }] };
      const rootCases: unknown[] = [];

      for (const definition of definitions) {
        const referenceSql = oracle.cases.find(item => item.name === definition.name)!.sql.replaceAll('generate_series(1,80000)', `generate_series(1,${rows})`);
        const expected = (await source.query<{ label: string | null; amount: string | null; entries: string; tags: string }>(referenceSql, [])).map(row => [row.label, row.amount, row.entries, row.tags]);
        const wholeSql = `SELECT tags.label AS "tags.label",MEASURE(root_entries.total) AS "root_entries.total",MEASURE(root_entries.count) AS "root_entries.count",MEASURE(tags.count) AS "tags.count"
          FROM root_entries LEFT JOIN tags ON root_entries.__cubeJoinField=tags.__cubeJoinField ${definition.predicate} GROUP BY 1 ORDER BY 1 NULLS LAST`;
        const whole = await endpoint.execute(wholeSql, 'reader'); expect(whole.rows).toEqual(expected);
        references.push({ id: definition.name, sql: referenceSql, rows: expected, wholeCubeQuery: wholeSql, wholeCubeRows: whole.rows });
        rootCases.push({ id: definition.name,
          query: { rootCube: 'root_entries',
            dimensions: ['tags.label'],
            measures: ['root_entries.total', 'root_entries.count', 'tags.count'],
            filters: definition.filters,
            resultOps: { sort: [{ id: 'tags.label', desc: false }] } },
          expected,
          inputRows: definition.inputRows,
          resultColumns: [{ name: 'tags.label', type: 'Utf8' }, { name: 'root_entries.total', type: 'Decimal128(38,9)' }, { name: 'root_entries.count', type: 'Int64' }, { name: 'tags.count', type: 'Int64' }] });
      }
      const bridgeSql = oracle.cases.find(item => item.name === 'bridge')!.sql.replaceAll('generate_series(1,80000)', `generate_series(1,${rows})`).replace("(1,'X')", "(1,'A')").replace("(3,'Y')", "(3,'B')");
      const bridgeExpected = (await source.query<{ label: string | null; amount: string | null; parents: string; entries: string; tags: string }>(bridgeSql, [])).map(row => [row.label, row.amount, row.parents, row.entries, row.tags]);
      const wholeBridgeSql = `SELECT tags.label AS "tags.label",MEASURE(parents.total) AS "parents.total",MEASURE(parents.count) AS "parents.count",MEASURE(bridge_entries.count) AS "bridge_entries.count",MEASURE(tags.count) AS "tags.count"
        FROM parents LEFT JOIN bridge_entries ON parents.__cubeJoinField=bridge_entries.__cubeJoinField
        LEFT JOIN tags ON bridge_entries.__cubeJoinField=tags.__cubeJoinField GROUP BY 1 ORDER BY 1 NULLS LAST`;
      const wholeBridge = await endpoint.execute(wholeBridgeSql, 'reader'); expect(wholeBridge.rows).toEqual(bridgeExpected);
      references.push({ id: 'bridge', sql: bridgeSql, rows: bridgeExpected, wholeCubeQuery: wholeBridgeSql, wholeCubeRows: wholeBridge.rows });
      const bridgeFacts = { operands: [
        { cube: 'parents', identity: ['parents.id'], dimensions: ['parents.id'], measures: [{ member: 'parents.total', combine: 'sum' }, { member: 'parents.count', combine: 'sum', emptyValue: 0 }] },
        { cube: 'bridge_entries', identity: ['bridge_entries.id'], dimensions: ['bridge_entries.id', 'bridge_entries.parent_id', 'bridge_entries.tag_key'], measures: [{ member: 'bridge_entries.count', combine: 'sum', emptyValue: 0 }] },
        rootFacts.operands[1],
      ],
      joins: [{ from: 'parents', to: 'bridge_entries', keys: [{ left: 'parents.id', right: 'bridge_entries.parent_id' }] }, { from: 'bridge_entries', to: 'tags', keys: [{ left: 'bridge_entries.tag_key', right: 'tags.id' }] }] };
      const fixtureSha256 = createHash('sha256').update(groupedModel + setup + JSON.stringify(references)).digest('hex');
      const run = async (name: string, facts: { operands: Array<{ cube: string }> }, cases: unknown[], expectedReads: number[]) => {
        const cubes = new Set(facts.operands.map(operand => operand.cube));
        const models = groupedCatalogModels.filter(catalogModel => cubes.has(catalogModel.name));
        const catalogBinding = { models,
          catalogs: models.map(catalogModel => [catalogModel.name, { dataSourceId: catalogModel.dataSourceId, catalog: 'grouped' }]),
          joins: groupedCatalogJoins.filter(edge => cubes.has(edge.fromOccurrence.occurrenceId) && cubes.has(edge.toOccurrence.occurrenceId)),
          declared: groupedDeclared.filter(edge => cubes.has(edge.from) && cubes.has(edge.to)) };
        writeFileSync(packetPath, JSON.stringify({ fixtureSha256, rawSourceRows: rows, transferCeiling, meta, facts, cases, catalogBinding }));
        const cursor = endpoint!.sourceRequests.length;
        await promisify(execFile)(process.execPath, [join(applicationRoot, 'apps/api/node_modules/vitest/vitest.mjs'), 'run', 'src/test/semantic-parity-integration/semantic-operand-fleet-wire.integration.test.ts'], {
          cwd: join(applicationRoot, 'apps/api'),
          timeout: 60000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, QUERYRAILS_OPERAND_CUBE_URL: endpoint!.url, QUERYRAILS_OPERAND_PACKET_PATH: packetPath, QUERYRAILS_OPERAND_CAPTURE_PATH: capturePath }
        });
        const capture = JSON.parse(readFileSync(capturePath, 'utf8')); const requests = endpoint!.sourceRequests.slice(cursor);
        expect(requests.map(request => request.rowCount)).toEqual(expectedReads);
        expect(requests.every(request => request.completed && request.principal === 'reader')).toBe(true);
        expect(requests.every(request => request.rowCount <= transferCeiling)).toBe(true);
        console.log('Grouped native operand capture', JSON.stringify({ name, fixtureSha256, rawSourceRows: rows, transferCeiling, references, ...capture, sourceRequests: requests }));
      };
      await run('root', rootFacts, rootCases, [4, 3, 4, 3, 8, 3, 4]);
      await run('bridge', bridgeFacts, [{ id: 'bridge',
        query: { rootCube: 'parents', dimensions: ['tags.label'], measures: ['parents.total', 'parents.count', 'bridge_entries.count', 'tags.count'], resultOps: { sort: [{ id: 'tags.label', desc: false }] } },
        expected: bridgeExpected,
        inputRows: [3, 12, 3],
        resultColumns: [{ name: 'tags.label', type: 'Utf8' }, { name: 'parents.total', type: 'Decimal128(38,2)' }, { name: 'parents.count', type: 'Int64' }, { name: 'bridge_entries.count', type: 'Int64' }, { name: 'tags.count', type: 'Int64' }] }], [3, 12, 3, 3]);
    } finally { await endpoint?.stop(); await source.release(); rmSync(directory, { recursive: true, force: true }); }
  });
});

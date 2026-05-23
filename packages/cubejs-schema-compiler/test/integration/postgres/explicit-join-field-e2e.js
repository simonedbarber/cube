/* eslint-disable no-console */
// End-to-end verification of the GATED reverse-edge synthesis behavior.
//
// Behavior contract:
//   - CUBEJS_BIDIRECTIONAL_SQL_JOINS=true + CUBEJS_TESSERACT_SQL_PLANNER=true
//     enables reverse synthesis for ExplicitJoinHint shapes ONLY.
//   - Plain `joinHints: [['customers','orders']]` (REST API style) must STILL
//     error like pre-PR, even when the feature flag is on.
//   - With the feature OFF, ALL reverse traversals must error like pre-PR.
//
// Run with:
//   TEST_DATABASE_URL=<postgres://...> \
//     node packages/cubejs-schema-compiler/test/integration/postgres/explicit-join-field-e2e.js

const { Client } = require('pg');
const path = require('path');

const distRoot = path.resolve(__dirname, '../../../dist/src');
const { prepareCompiler } = require(path.join(distRoot, 'compiler/PrepareCompiler'));
const { PostgresQuery } = require(path.join(distRoot, 'adapter/PostgresQuery'));

const CONN = process.env.TEST_DATABASE_URL;
if (!CONN) {
  console.error('Set TEST_DATABASE_URL to the Postgres URL.');
  process.exit(2);
}

const SCHEMA = `
  cube('orders', {
    sql: \`SELECT * FROM e2e_orders\`,
    joins: {
      customers: {
        relationship: \`many_to_one\`,
        sql: \`\${CUBE}.customer_id = \${customers}.id\`
      }
    },
    dimensions: {
      id:          { sql: \`id\`,          type: \`number\`, primary_key: true, public: true },
      customer_id: { sql: \`customer_id\`, type: \`number\` }
    },
    measures: { count: { type: \`count\` } }
  });

  cube('customers', {
    sql: \`SELECT * FROM e2e_customers\`,
    dimensions: {
      id:   { sql: \`id\`,   type: \`number\`, primary_key: true, public: true },
      name: { sql: \`name\`, type: \`string\` }
    },
    measures: { count: { type: \`count\` } }
  });
`;

const prepareData = async (client) => {
  await client.query('DROP TABLE IF EXISTS e2e_orders');
  await client.query('DROP TABLE IF EXISTS e2e_customers');
  await client.query('CREATE TABLE e2e_customers (id INT PRIMARY KEY, name TEXT)');
  await client.query('CREATE TABLE e2e_orders   (id INT PRIMARY KEY, customer_id INT)');
  await client.query(`INSERT INTO e2e_customers (id, name) VALUES (1, 'Alice'), (2, 'Bob')`);
  await client.query(`INSERT INTO e2e_orders   (id, customer_id) VALUES (1, 1), (2, 1)`);
};

const cleanup = async (client) => {
  await client.query('DROP TABLE IF EXISTS e2e_orders');
  await client.query('DROP TABLE IF EXISTS e2e_customers');
};

const compile = async () => {
  const compilers = prepareCompiler({
    localPath: () => __dirname,
    dataSchemaFiles: () => Promise.resolve([{ fileName: 'main.js', content: SCHEMA }])
  }, { adapter: 'postgres' });
  await compilers.compiler.compile();
  return compilers;
};

const SENTINEL = '__cubeExplicitJoinField__sentinel__';

// `kind: 'joinHints'`  → legacy plain string[] hint shape (REST/SQL API joinHints).
// `kind: 'explicit'`   → sentinel-prefixed hint, the actual wire-format
//                        produced by cubesql for `__cubeExplicitJoinField`.
//                        The sentinel rides inside the same `joinHints` array
//                        so SQL clause order is preserved (no separate field).
// We force `useNativeSqlPlanner: false` to stay on the JS planner — Tesseract
// auto-fallback is also covered by unit tests, this script focuses on the
// query-output behavior.
const runQuery = async (client, compilers, kind, path) => {
  const hint = kind === 'explicit' ? [SENTINEL, ...path] : path;
  const query = new PostgresQuery(compilers, {
    // Measures the orders count grouped by customer name. This requires
    // joining customers and orders no matter the direction, so the hint's
    // routing actually matters (a single-cube query would mask the bug).
    measures: ['orders.count'],
    dimensions: ['customers.name'],
    joinHints: [hint],
    order: [['customers.name', 'asc']],
    timezone: 'UTC',
    useNativeSqlPlanner: false,
  });
  const [sql, params] = query.buildSqlAndParams();
  const res = await client.query(sql, params);
  return res.rows;
};

const tryQuery = async (label, fn) => {
  console.log(`\n--- ${label} ---`);
  try {
    const result = await fn();
    console.log(`OK: ${label}`);
    return { ok: true, result };
  } catch (e) {
    console.log(`ERROR: ${label}: ${e.message.split('\n')[0]}`);
    return { ok: false, error: e };
  }
};

const names = (rows) => rows.map(r => r.customers__name).sort();
const countFor = (rows, name) => {
  const row = rows.find(r => r.customers__name === name);
  return row ? Number(row.orders__count) : 0;
};

const main = async () => {
  let exitCode = 0;
  const client = new Client({ connectionString: CONN });
  await client.connect();

  try {
    await prepareData(client);

    // ============================================================
    // PHASE 1: Feature OFF (pre-PR behavior)
    // ============================================================
    console.log('\n========================================');
    console.log('PHASE 1: feature OFF');
    console.log('========================================');
    delete process.env.CUBEJS_BIDIRECTIONAL_SQL_JOINS;
    let compilers = await compile();

    const off_forward = await tryQuery('OFF: forward (declared direction)',
      () => runQuery(client, compilers, 'joinHints', ['orders', 'customers']));
    const off_reverse_plain = await tryQuery('OFF: reverse plain joinHints',
      () => runQuery(client, compilers, 'joinHints', ['customers', 'orders']));
    const off_reverse_explicit = await tryQuery('OFF: reverse explicit (sentinel-prefixed)',
      () => runQuery(client, compilers, 'explicit', ['customers', 'orders']));

    if (!off_forward.ok) { console.error('FAIL: OFF forward should succeed'); exitCode = 1; }
    if (!off_reverse_plain.ok) {
      console.error('FAIL: OFF reverse plain should succeed (auto-resolver finds declared direction)'); exitCode = 1;
    }
    if (!off_reverse_explicit.ok) {
      console.error('FAIL: OFF reverse explicit-sentinel should succeed (sentinel ignored when flag off, falls back to auto-resolver)'); exitCode = 1;
    }
    // OFF: every direction collapses to the declared `orders → customers`,
    // so Bob (who has no orders) MUST be absent from every result.
    for (const [label, result] of [['forward', off_forward], ['reverse plain', off_reverse_plain], ['reverse explicit', off_reverse_explicit]]) {
      if (!result.ok) continue;
      const got = names(result.result);
      if (got.includes('Bob')) {
        console.error(`FAIL: OFF ${label} must NOT include Bob (feature off → declared direction), got: ${got}`);
        exitCode = 1;
      } else {
        console.log(`OK: OFF ${label} excluded Bob (declared direction)`);
      }
    }

    // ============================================================
    // PHASE 2: Feature ON
    // ============================================================
    console.log('\n========================================');
    console.log('PHASE 2: feature ON');
    console.log('========================================');
    // Single flag — no Tesseract or pushdown required for the JS pipeline.
    process.env.CUBEJS_BIDIRECTIONAL_SQL_JOINS = 'true';
    compilers = await compile();

    const on_forward = await tryQuery('ON: forward (declared direction)',
      () => runQuery(client, compilers, 'joinHints', ['orders', 'customers']));
    const on_reverse_plain = await tryQuery('ON: reverse plain joinHints',
      () => runQuery(client, compilers, 'joinHints', ['customers', 'orders']));
    const on_reverse_explicit = await tryQuery('ON: reverse explicit (sentinel-prefixed)',
      () => runQuery(client, compilers, 'explicit', ['customers', 'orders']));

    if (!on_forward.ok) { console.error('FAIL: ON forward should succeed'); exitCode = 1; }
    if (!on_reverse_plain.ok) {
      console.error('FAIL: ON reverse plain should succeed (auto-resolver still finds declared direction)'); exitCode = 1;
    }
    if (!on_reverse_explicit.ok) { console.error('FAIL: ON reverse explicit should succeed'); exitCode = 1; }
    // Forward AND reverse-plain should produce only Alice (declared direction).
    // Reverse-explicit MUST include Bob — the synthesized reverse edge makes
    // customers the row-preserving root, so customers without orders appear.
    if (on_forward.ok) {
      const got = names(on_forward.result);
      if (got.includes('Bob')) { console.error(`FAIL: ON forward must NOT include Bob, got: ${got}`); exitCode = 1; }
      else { console.log('OK: ON forward excluded Bob (declared direction)'); }
    }
    if (on_reverse_plain.ok) {
      const got = names(on_reverse_plain.result);
      if (got.includes('Bob')) {
        console.error(`FAIL: ON reverse plain must NOT include Bob (only sentinel-prefixed hints get synthesis), got: ${got}`);
        exitCode = 1;
      } else {
        console.log('OK: ON reverse plain excluded Bob (no synthesis for plain hints)');
      }
    }
    if (on_reverse_explicit.ok) {
      const got = names(on_reverse_explicit.result);
      if (!got.includes('Bob')) {
        console.error(`FAIL: ON reverse explicit MUST include Bob (synthesized reverse edge), got: ${got}`);
        exitCode = 1;
      } else {
        console.log('OK: ON reverse explicit included Bob (reverse-edge synthesis)');
      }
    }

    // ============================================================
    // Summary
    // ============================================================
    console.log('\n========================================');
    console.log(exitCode === 0 ? 'ALL ASSERTIONS PASSED' : 'SOME ASSERTIONS FAILED');
    console.log('========================================');
  } catch (e) {
    console.error('Fatal:', e);
    exitCode = 1;
  } finally {
    try { await cleanup(client); } catch (e) { /* best-effort */ }
    await client.end();
    process.exit(exitCode);
  }
};

main().catch(e => { console.error(e); process.exit(1); });

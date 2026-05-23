import { prepareJsCompiler } from './PrepareCompiler';
// eslint-disable-next-line import/no-extraneous-dependencies
import { PostgresQuery } from '../../src/adapter/PostgresQuery';
import { EXPLICIT_JOIN_HINT_SENTINEL } from '../../src/compiler/JoinGraph';

// Tests for the gated reverse-edge synthesis behavior. The feature in the JS
// pipeline is gated by a single env var: CUBEJS_BIDIRECTIONAL_SQL_JOINS=true.
// (cubesql separately gates `__cubeExplicitJoinField` SQL recognition behind
// CUBESQL_SQL_PUSH_DOWN as that is the only path that surfaces the token; this
// JS test exercises the pipeline directly so push-down doesn't apply.)
// When OFF (default): behavior matches pre-feature exactly — any reverse traversal
// of a declared edge returns null and `buildJoin` throws the legacy "Can't find
// join path…" error.
// When ON: only `ExplicitJoinHint = { path, explicit: true }` hints are allowed to
// trigger reverse-edge synthesis. Plain `string[]` hints (which is what every
// existing source emits — `__cubeJoinField`, REST `joinHints`, member resolution,
// pre-aggregations, /meta) keep the strictly directed traversal.

// Schema A: single-direction model `orders → customers` (only orders declares).
// Both cubes carry a `count` measure so full-pipeline tests can exercise
// `new PostgresQuery({ measures: ['customers.count'], … })`.
const buildOrdersCustomersCompiler = (relationship: string) => prepareJsCompiler(`
  cube('orders', {
    sql: \`SELECT 1 as id, 1 as customer_id\`,
    joins: {
      customers: {
        relationship: \`${relationship}\`,
        sql: \`\${CUBE}.customer_id = \${customers}.id\`
      }
    },
    dimensions: { id: { sql: \`id\`, type: \`number\`, primary_key: true, public: true } },
    measures: { count: { type: \`count\` } }
  });
  cube('customers', {
    sql: \`SELECT 1 as id, 'Foo' as name\`,
    dimensions: {
      id:   { sql: \`id\`,   type: \`number\`, primary_key: true, public: true },
      name: { sql: \`name\`, type: \`string\` }
    },
    measures: { count: { type: \`count\` } }
  });
`);

// Schema B: chain `a → b → c` (each cube declares the join to its right neighbor).
const buildAbcChainCompiler = () => prepareJsCompiler(`
  cube('a', {
    sql: \`SELECT 1 as id, 1 as b_id\`,
    joins: { b: { relationship: \`many_to_one\`, sql: \`\${CUBE}.b_id = \${b}.id\` } },
    dimensions: { id: { sql: \`id\`, type: \`number\`, primary_key: true, public: true } },
    measures: { count: { type: \`count\` } }
  });
  cube('b', {
    sql: \`SELECT 1 as id, 1 as c_id\`,
    joins: { c: { relationship: \`many_to_one\`, sql: \`\${CUBE}.c_id = \${c}.id\` } },
    dimensions: { id: { sql: \`id\`, type: \`number\`, primary_key: true, public: true } },
    measures: { count: { type: \`count\` } }
  });
  cube('c', {
    sql: \`SELECT 1 as id\`,
    dimensions: { id: { sql: \`id\`, type: \`number\`, primary_key: true, public: true } },
    measures: { count: { type: \`count\` } }
  });
`);

// Schema C: bidirectional declared joins `a ↔ b` (both cubes declare each other).
// Documented as discouraged but supported by Cube; used to verify explicit hint
// precedence picks the declared direction matching the explicit path.
const buildBidirectionalCompiler = () => prepareJsCompiler(`
  cube('a', {
    sql: \`SELECT 1 as id, 1 as b_id\`,
    joins: { b: { relationship: \`many_to_one\`, sql: \`\${CUBE}.b_id = \${b}.id\` } },
    dimensions: { id: { sql: \`id\`, type: \`number\`, primary_key: true, public: true } },
    measures: { count: { type: \`count\` } }
  });
  cube('b', {
    sql: \`SELECT 1 as id, 1 as a_id\`,
    joins: { a: { relationship: \`many_to_one\`, sql: \`\${CUBE}.a_id = \${a}.id\` } },
    dimensions: { id: { sql: \`id\`, type: \`number\`, primary_key: true, public: true } },
    measures: { count: { type: \`count\` } }
  });
`);

describe('JoinGraph reverse-direction synthesis (gated)', () => {
  jest.setTimeout(30000);

  // Reset feature-flag env vars between tests so the default state is "off".
  // IMPORTANT: do NOT reassign `process.env = ...` — the `env-var` library used
  // by `getEnv` captures the process.env reference at module load time, so a
  // reassignment leaves env-var reading from a now-stale object. Mutate in
  // place via `delete` instead.
  const flagKeys = [
    'CUBEJS_BIDIRECTIONAL_SQL_JOINS',
    'CUBEJS_TESSERACT_SQL_PLANNER',
    'CUBESQL_SQL_PUSH_DOWN',
  ];
  afterEach(() => {
    for (const k of flagKeys) {
      delete process.env[k];
    }
  });

  const enableFeature = () => {
    process.env.CUBEJS_BIDIRECTIONAL_SQL_JOINS = 'true';
  };

  // --- Default (feature OFF): legacy behavior preserved ---

  describe('with feature OFF (default env)', () => {
    it('declared direction (orders → customers) works as before', async () => {
      const { compiler, joinGraph } = buildOrdersCustomersCompiler('many_to_one');
      await compiler.compile();

      const tree = joinGraph.buildJoin([['orders', 'customers']]);
      expect(tree).not.toBeNull();
      expect(tree!.root).toBe('orders');
      expect(tree!.joins).toHaveLength(1);
      const edge = tree!.joins[0];
      expect(edge.synthetic).toBeUndefined();
      expect(edge.declaredOn).toBe('orders');
    });

    it('reverse direction with a plain string[] hint throws (no synthesis)', async () => {
      const { compiler, joinGraph } = buildOrdersCustomersCompiler('many_to_one');
      await compiler.compile();

      expect(() => joinGraph.buildJoin([['customers', 'orders']]))
        .toThrow(/Can't find join path/);
    });

    it('reverse direction with an ExplicitJoinHint also throws while feature is OFF', async () => {
      const { compiler, joinGraph } = buildOrdersCustomersCompiler('many_to_one');
      await compiler.compile();

      expect(() => joinGraph.buildJoin([{ path: ['customers', 'orders'], explicit: true } as any]))
        .toThrow(/Can't find join path/);
    });
  });

  // --- Feature ON: reverse synthesis only via ExplicitJoinHint ---

  describe('with feature ON', () => {
    it('plain string[] reverse hint STILL throws (only ExplicitJoinHint may synthesize)', async () => {
      enableFeature();
      const { compiler, joinGraph } = buildOrdersCustomersCompiler('many_to_one');
      await compiler.compile();

      expect(() => joinGraph.buildJoin([['customers', 'orders']]))
        .toThrow(/Can't find join path/);
    });

    it('ExplicitJoinHint reverse traversal synthesizes a flipped edge', async () => {
      enableFeature();
      const { compiler, joinGraph } = buildOrdersCustomersCompiler('many_to_one');
      await compiler.compile();

      const tree = joinGraph.buildJoin([{ path: ['customers', 'orders'], explicit: true } as any]);
      expect(tree).not.toBeNull();
      expect(tree!.root).toBe('customers');
      expect(tree!.joins).toHaveLength(1);
      const edge = tree!.joins[0];
      expect(edge.synthetic).toBe(true);
      expect(edge.from).toBe('customers');
      expect(edge.to).toBe('orders');
      expect(edge.declaredOn).toBe('orders');
    });

    it('declared direction with ExplicitJoinHint produces a non-synthetic edge', async () => {
      enableFeature();
      const { compiler, joinGraph } = buildOrdersCustomersCompiler('many_to_one');
      await compiler.compile();

      const tree = joinGraph.buildJoin([{ path: ['orders', 'customers'], explicit: true } as any]);
      const edge = tree!.joins[0];
      expect(edge.synthetic).toBeUndefined();
      expect(edge.from).toBe('orders');
      expect(edge.to).toBe('customers');
    });

    it('reverse synthesis inverts belongsTo to hasMany', async () => {
      enableFeature();
      const { compiler, joinGraph } = buildOrdersCustomersCompiler('belongsTo');
      await compiler.compile();
      const tree = joinGraph.buildJoin([{ path: ['customers', 'orders'], explicit: true } as any]);
      const edge = tree!.joins[0];
      expect(edge.synthetic).toBe(true);
      expect(edge.join.relationship).toBe('hasMany');
    });

    it('reverse synthesis inverts hasMany to belongsTo', async () => {
      enableFeature();
      const { compiler, joinGraph } = buildOrdersCustomersCompiler('hasMany');
      await compiler.compile();
      const tree = joinGraph.buildJoin([{ path: ['customers', 'orders'], explicit: true } as any]);
      const edge = tree!.joins[0];
      expect(edge.synthetic).toBe(true);
      expect(edge.join.relationship).toBe('belongsTo');
    });

    it('reverse synthesis keeps hasOne unchanged (symmetric cardinality)', async () => {
      enableFeature();
      const { compiler, joinGraph } = buildOrdersCustomersCompiler('hasOne');
      await compiler.compile();
      const tree = joinGraph.buildJoin([{ path: ['customers', 'orders'], explicit: true } as any]);
      const edge = tree!.joins[0];
      expect(edge.synthetic).toBe(true);
      expect(edge.join.relationship).toBe('hasOne');
    });
  });

  // --- Mixed-hint scenarios: explicit + auto ---
  // These are the cases the user flagged: when an explicit-direction hint shares a
  // query with auto-resolved hints (member references, `__cubeJoinField`, etc.),
  // the explicit direction MUST win — the root pins to cubesToJoin[0] (the SQL
  // FROM cube) and every ExplicitJoinHint's direction is honored regardless of
  // what shortest-path the planner would otherwise prefer.

  describe('mixed explicit + auto-resolved hints', () => {
    it('FROM root is preserved across mixed regular + explicit hints', async () => {
      enableFeature();
      const { compiler, joinGraph } = buildAbcChainCompiler();
      await compiler.compile();

      // Query shape: `FROM a LEFT JOIN b LEFT JOIN c ON __cubeExplicitJoinField`.
      // The SQL FROM is `a` (cubesToJoin[0]); the explicit hint covers b→c.
      // The candidate-root sweep must NOT pick `c` (which would invert the
      // entire join tree direction); the FROM cube must stay the root.
      const tree = joinGraph.buildJoin([
        ['a', 'b'],
        { path: ['b', 'c'], explicit: true } as any,
      ]);

      expect(tree).not.toBeNull();
      expect(tree!.root).toBe('a');
      // Joins should be [a→b, b→c], both declared edges (no synthesis required).
      const fromTo = tree!.joins.map(j => `${j.from}→${j.to}`);
      expect(fromTo).toEqual(['a→b', 'b→c']);
      expect(tree!.joins.every(j => !j.synthetic)).toBe(true);
    });

    it('mixed regular + explicit-reverse hint: explicit reverse synthesizes while FROM root holds', async () => {
      enableFeature();
      // a → b declared; c → b declared (c is the "many" side). Query asks to start
      // from `a`, join `b` (declared), then "reverse" join `c` (i.e., b → c, which
      // the model declares only as c → b — must synthesize).
      const { compiler, joinGraph } = prepareJsCompiler(`
        cube('a', {
          sql: \`SELECT 1 as id, 1 as b_id\`,
          joins: { b: { relationship: \`many_to_one\`, sql: \`\${CUBE}.b_id = \${b}.id\` } },
          dimensions: { id: { sql: \`id\`, type: \`number\`, primary_key: true, public: true } },
          measures: { count: { type: \`count\` } }
        });
        cube('b', {
          sql: \`SELECT 1 as id\`,
          dimensions: { id: { sql: \`id\`, type: \`number\`, primary_key: true, public: true } }
        });
        cube('c', {
          sql: \`SELECT 1 as id, 1 as b_id\`,
          joins: { b: { relationship: \`many_to_one\`, sql: \`\${CUBE}.b_id = \${b}.id\` } },
          dimensions: { id: { sql: \`id\`, type: \`number\`, primary_key: true, public: true } },
          measures: { count: { type: \`count\` } }
        });
      `);
      await compiler.compile();

      const tree = joinGraph.buildJoin([
        ['a', 'b'],
        { path: ['b', 'c'], explicit: true } as any,
      ]);

      expect(tree).not.toBeNull();
      expect(tree!.root).toBe('a');
      const fromTo = tree!.joins.map(j => `${j.from}→${j.to}`);
      expect(fromTo).toEqual(['a→b', 'b→c']);
      // a→b is declared, b→c is synthesized (model only declares c→b).
      expect(tree!.joins[0].synthetic).toBeUndefined();
      expect(tree!.joins[1].synthetic).toBe(true);
      expect(tree!.joins[1].declaredOn).toBe('c');
      expect(tree!.joins[1].join.relationship).toBe('hasMany');
    });

    it('explicit hint is NOT silently overridden by a shorter alternative tree', async () => {
      enableFeature();
      // Bidirectional model `a ↔ b`. Without explicit pinning, the candidate-
      // root sweep would happily root on `b` (same length tree), discarding the
      // user's `a → b` intent. With pinning, root must be `a`.
      const { compiler, joinGraph } = buildBidirectionalCompiler();
      await compiler.compile();

      const tree = joinGraph.buildJoin([
        { path: ['a', 'b'], explicit: true } as any,
      ]);
      expect(tree!.root).toBe('a');
      const edge = tree!.joins[0];
      expect(edge.from).toBe('a');
      expect(edge.to).toBe('b');
      // Declared a→b edge exists; explicit hint picks it (no synthesis even
      // though b→a is also declared).
      expect(edge.synthetic).toBeUndefined();
      expect(edge.declaredOn).toBe('a');
    });

    it('opposite explicit direction in bidirectional model picks the OTHER declared edge', async () => {
      enableFeature();
      const { compiler, joinGraph } = buildBidirectionalCompiler();
      await compiler.compile();

      const tree = joinGraph.buildJoin([
        { path: ['b', 'a'], explicit: true } as any,
      ]);
      expect(tree!.root).toBe('b');
      const edge = tree!.joins[0];
      expect(edge.from).toBe('b');
      expect(edge.to).toBe('a');
      // Declared b→a edge exists in the bidirectional model → use it directly,
      // no synthesis.
      expect(edge.synthetic).toBeUndefined();
      expect(edge.declaredOn).toBe('b');
    });

    it('explicit hint at position 1 (after a regular hint) keeps FROM root and honors its direction', async () => {
      enableFeature();
      // Models exactly the user's concern: FROM cube comes first as a plain hint,
      // the explicit hint is appended afterwards. The root must still be `a`,
      // and the explicit `b → c` direction is honored even though graph.path
      // would have found a path either way (no synthesis here — it's the
      // PRECEDENCE check that matters).
      const { compiler, joinGraph } = buildAbcChainCompiler();
      await compiler.compile();

      const tree = joinGraph.buildJoin([
        'a',
        { path: ['b', 'c'], explicit: true } as any,
      ]);

      expect(tree!.root).toBe('a');
      const fromTo = tree!.joins.map(j => `${j.from}→${j.to}`);
      // The planner must traverse a→b (declared) to reach b, then b→c (the
      // explicit hint's direction). The path is a→b→c, NOT c→b→a.
      expect(fromTo).toEqual(['a→b', 'b→c']);
    });

    it('multiple ExplicitJoinHints chain together with consistent root pinning', async () => {
      enableFeature();
      const { compiler, joinGraph } = buildAbcChainCompiler();
      await compiler.compile();

      const tree = joinGraph.buildJoin([
        { path: ['a', 'b'], explicit: true } as any,
        { path: ['b', 'c'], explicit: true } as any,
      ]);

      expect(tree!.root).toBe('a');
      const fromTo = tree!.joins.map(j => `${j.from}→${j.to}`);
      expect(fromTo).toEqual(['a→b', 'b→c']);
      expect(tree!.joins.every(j => !j.synthetic)).toBe(true);
    });
  });

  // --- View join_path scenarios ---

  describe('view join_path enrichment (when feature ON)', () => {
    // View join_path → typed ExplicitJoinHint happens in BaseQuery
    // `enrichHintsWithJoinMap`, but the gate inside JoinGraph is the same.
    // These tests simulate the exact shape `enrichHintsWithJoinMap` produces.
    it('view join_path: customers.orders synthesizes reverse against single-direction model', async () => {
      enableFeature();
      const { compiler, joinGraph } = buildOrdersCustomersCompiler('many_to_one');
      await compiler.compile();

      const tree = joinGraph.buildJoin([
        { path: ['customers', 'orders'], explicit: true } as any,
      ]);
      expect(tree!.root).toBe('customers');
      expect(tree!.joins[0].synthetic).toBe(true);
    });

    it('view join_path: orders.customers honors declared direction (no synthesis)', async () => {
      enableFeature();
      const { compiler, joinGraph } = buildOrdersCustomersCompiler('many_to_one');
      await compiler.compile();

      const tree = joinGraph.buildJoin([
        { path: ['orders', 'customers'], explicit: true } as any,
      ]);
      expect(tree!.root).toBe('orders');
      expect(tree!.joins[0].synthetic).toBeUndefined();
    });
  });

  // --- Error paths and edge cases ---

  describe('error and edge cases', () => {
    it('throws when explicit hint references an unrelated cube (no path either direction)', async () => {
      enableFeature();
      const { compiler, joinGraph } = prepareJsCompiler(`
        cube('a', {
          sql: \`SELECT 1 as id\`,
          dimensions: { id: { sql: \`id\`, type: \`number\`, primary_key: true, public: true } }
        });
        cube('zzz_unrelated', {
          sql: \`SELECT 1 as id\`,
          dimensions: { id: { sql: \`id\`, type: \`number\`, primary_key: true, public: true } }
        });
      `);
      await compiler.compile();

      expect(() => joinGraph.buildJoin([
        { path: ['a', 'zzz_unrelated'], explicit: true } as any,
      ])).toThrow(/Can't find join path/);
    });

    it('declared a→b cached separately from explicit reverse b→a (cache keys differ)', async () => {
      enableFeature();
      const { compiler, joinGraph } = buildOrdersCustomersCompiler('many_to_one');
      await compiler.compile();

      const forward = joinGraph.buildJoin([['orders', 'customers']]);
      const reverse = joinGraph.buildJoin([
        { path: ['customers', 'orders'], explicit: true } as any,
      ]);
      // Distinct trees: forward uses declared edge; reverse uses synthetic edge.
      expect(forward!.root).toBe('orders');
      expect(reverse!.root).toBe('customers');
      expect(forward!.joins[0].synthetic).toBeUndefined();
      expect(reverse!.joins[0].synthetic).toBe(true);
    });

    it('explicit hint identity (originalFrom/originalTo) is swapped on synthetic edge', async () => {
      enableFeature();
      const { compiler, joinGraph } = buildOrdersCustomersCompiler('many_to_one');
      await compiler.compile();

      const tree = joinGraph.buildJoin([
        { path: ['customers', 'orders'], explicit: true } as any,
      ]);
      const edge = tree!.joins[0];
      // Downstream consumers (BaseQuery.js:2289, multi_fact_join_groups.rs:297)
      // read these as logical traversal direction; synthetic must swap them so
      // those consumers see the actual direction the query traversed.
      expect(edge.originalFrom).toBe('customers');
      expect(edge.originalTo).toBe('orders');
      // declaredOn must point at the original declaring cube so SQL emission
      // resolves `${CUBE}` correctly (BaseQuery.js:2289 uses this for the ON SQL).
      expect(edge.declaredOn).toBe('orders');
    });
  });

  // --- Sentinel parsing through full BaseQuery pipeline ---
  // These tests exercise the actual wire-format that cubesql produces: a hint
  // array whose first element is `EXPLICIT_JOIN_HINT_SENTINEL`. BaseQuery
  // converts these in place to `ExplicitJoinHint` at the same array position,
  // preserving SQL clause order. This is the post-fix path for the high-priority
  // ordering bug — splitting into a separate `explicitJoinHints` field could
  // silently re-root a query that started with an explicit JOIN.

  describe('sentinel hints through BaseQuery (full pipeline)', () => {
    const buildBaseQuery = (compilers: any, options: any) => new PostgresQuery(compilers, {
      timezone: 'UTC',
      useNativeSqlPlanner: false,
      ...options,
    });

    it('sentinel-prefixed hint becomes ExplicitJoinHint at the same position', async () => {
      enableFeature();
      const compilers = buildOrdersCustomersCompiler('many_to_one');
      await compilers.compiler.compile();

      const query = buildBaseQuery(compilers, {
        measures: ['customers.count'],
        dimensions: ['customers.name'],
        joinHints: [[EXPLICIT_JOIN_HINT_SENTINEL, 'customers', 'orders']],
      });
      const tree = (query as any).joinGraph.buildJoin((query as any).queryLevelJoinHints);
      expect(tree.root).toBe('customers');
      expect(tree.joins[0].synthetic).toBe(true);
    });

    it('regular hint BEFORE sentinel hint: FROM root stays on the regular hint', async () => {
      // The exact bug from the reviewer's Finding 1, after the fix: clause order
      // must be preserved. `FROM a LEFT JOIN b LEFT JOIN c ON __cubeExplicitJoinField`
      // → wire-format `joinHints: [[a, b], [sentinel, b, c]]`. cubesToJoin[0]
      // must be `[a, b]` so the root is `a`, not the explicit hint's first cube.
      enableFeature();
      const compilers = buildAbcChainCompiler();
      await compilers.compiler.compile();

      const query = buildBaseQuery(compilers, {
        measures: ['c.count'],
        dimensions: [],
        joinHints: [['a', 'b'], [EXPLICIT_JOIN_HINT_SENTINEL, 'b', 'c']],
      });
      const tree = (query as any).joinGraph.buildJoin((query as any).queryLevelJoinHints);
      expect(tree.root).toBe('a');
      const fromTo = tree.joins.map((j: any) => `${j.from}→${j.to}`);
      expect(fromTo).toEqual(['a→b', 'b→c']);
    });

    it('sentinel hint BEFORE regular hint: FROM root stays on the explicit hint head', async () => {
      // Inverse interleaving: `FROM a LEFT JOIN b ON __cubeExplicitJoinField LEFT JOIN c`
      // → `joinHints: [[sentinel, a, b], [b, c]]`. cubesToJoin[0] must be the
      // explicit hint so root is `a`, NOT `b` (which would be the result of the
      // pre-fix "split + concat" bug that put the regular hint first).
      enableFeature();
      const compilers = buildAbcChainCompiler();
      await compilers.compiler.compile();

      const query = buildBaseQuery(compilers, {
        measures: ['c.count'],
        dimensions: [],
        joinHints: [[EXPLICIT_JOIN_HINT_SENTINEL, 'a', 'b'], ['b', 'c']],
      });
      const tree = (query as any).joinGraph.buildJoin((query as any).queryLevelJoinHints);
      expect(tree.root).toBe('a');
      const fromTo = tree.joins.map((j: any) => `${j.from}→${j.to}`);
      expect(fromTo).toEqual(['a→b', 'b→c']);
    });

    it('Tesseract path keeps useNativeSqlPlanner=true (JoinGraph decodes sentinel via bridge)', async () => {
      // The cubesql egraph emits sentinel-prefixed joinHints. Tesseract's
      // `JoinPlanner` bridges into JS `JoinGraph.build_join` for every query,
      // and `JoinGraph` decodes the sentinel at the bridge entry point — so
      // explicit-direction queries planned by Tesseract pick up reverse-edge
      // synthesis natively. No JS-pipeline fallback needed.
      process.env.CUBEJS_BIDIRECTIONAL_SQL_JOINS = 'true';
      process.env.CUBEJS_TESSERACT_SQL_PLANNER = 'true';
      const compilers = buildOrdersCustomersCompiler('many_to_one');
      await compilers.compiler.compile();

      const query = buildBaseQuery(compilers, {
        measures: ['customers.count'],
        dimensions: ['customers.name'],
        joinHints: [[EXPLICIT_JOIN_HINT_SENTINEL, 'customers', 'orders']],
        useNativeSqlPlanner: true,
      });
      // Tesseract stays in charge — the operator's planner choice is honored
      // for every query type, not just plain ones.
      expect((query as any).useNativeSqlPlanner).toBe(true);
    });

    it('JoinGraph decodes sentinel even when caller skipped BaseQuery normalization', async () => {
      // Simulates the Tesseract → JS bridge call: raw sentinel-prefixed arrays
      // arrive directly at `JoinGraph.buildJoin` without ever passing through
      // BaseQuery's defensive early-parse. `JoinGraph` must decode them itself.
      enableFeature();
      const compilers = buildOrdersCustomersCompiler('many_to_one');
      await compilers.compiler.compile();

      const tree = (compilers.joinGraph as any).buildJoin([
        [EXPLICIT_JOIN_HINT_SENTINEL, 'customers', 'orders'],
      ]);
      expect(tree.root).toBe('customers');
      expect(tree.joins[0].synthetic).toBe(true);
      expect(tree.joins[0].declaredOn).toBe('orders');
    });
  });

  // --- View join_path full-pipeline tests ---
  // Earlier "view join_path" tests simulated the post-enrichment shape directly.
  // These exercise an actual view definition, going through
  // `CubeSymbols.joinMap` → `BaseQuery.queryJoinMap` → `enrichHintsWithJoinMap`.

  describe('view join_path enrichment (full pipeline)', () => {
    // Build a view rooted on `customers` whose second cube reaches `orders` via
    // a reverse `join_path` against the declared `orders → customers` edge.
    // This exercises `CubeSymbols.joinMap` → `BaseQuery.queryJoinMap` →
    // `enrichHintsWithJoinMap` end-to-end.
    const buildReverseViewCompiler = () => prepareJsCompiler(`
      cube('orders', {
        sql: \`SELECT 1 as id, 1 as customer_id\`,
        joins: {
          customers: {
            relationship: \`many_to_one\`,
            sql: \`\${CUBE}.customer_id = \${customers}.id\`
          }
        },
        dimensions: { id: { sql: \`id\`, type: \`number\`, primary_key: true, public: true } },
        measures: { count: { type: \`count\` } }
      });
      cube('customers', {
        sql: \`SELECT 1 as id, 'Foo' as name\`,
        dimensions: {
          id:   { sql: \`id\`,   type: \`number\`, primary_key: true, public: true },
          name: { sql: \`name\`, type: \`string\` }
        },
        measures: { count: { type: \`count\` } }
      });
      view('rev_view', {
        cubes: [
          { join_path: customers, includes: ['name'] },
          { join_path: customers.orders, includes: ['count'] }
        ]
      });
    `);

    const buildForwardViewCompiler = () => prepareJsCompiler(`
      cube('orders', {
        sql: \`SELECT 1 as id, 1 as customer_id\`,
        joins: {
          customers: {
            relationship: \`many_to_one\`,
            sql: \`\${CUBE}.customer_id = \${customers}.id\`
          }
        },
        dimensions: { id: { sql: \`id\`, type: \`number\`, primary_key: true, public: true } },
        measures: { count: { type: \`count\` } }
      });
      cube('customers', {
        sql: \`SELECT 1 as id, 'Foo' as name\`,
        dimensions: {
          id:   { sql: \`id\`,   type: \`number\`, primary_key: true, public: true },
          name: { sql: \`name\`, type: \`string\` }
        },
        measures: { count: { type: \`count\` } }
      });
      view('fwd_view', {
        cubes: [
          { join_path: orders, includes: ['count'] },
          { join_path: orders.customers, includes: ['name'] }
        ]
      });
    `);

    it('view with reverse join_path (customers.orders) synthesizes when feature ON', async () => {
      enableFeature();
      const compilers = buildReverseViewCompiler();
      await compilers.compiler.compile();

      // Run a query against the view; the joinMap-derived path will be enriched
      // by `enrichHintsWithJoinMap` and tagged as `ExplicitJoinHint` because
      // the feature flag is on. Reverse-edge synthesis fires inside JoinGraph.
      const query = new PostgresQuery(compilers, {
        measures: ['rev_view.count'],
        dimensions: ['rev_view.name'],
        timezone: 'UTC',
        useNativeSqlPlanner: false,
      });
      // The fact that `buildSqlAndParams` succeeds means the joinMap path went
      // through reverse synthesis end-to-end (without it, `customers → orders`
      // would error out as the model only declares `orders → customers`).
      expect(() => query.buildSqlAndParams()).not.toThrow();
    });

    it('view with reverse join_path errors when feature OFF (pre-PR behavior)', async () => {
      // Without the feature flag, the view's reverse `join_path` cannot
      // traverse — `enrichHintsWithJoinMap` returns a plain `string[]` (no
      // explicit tag), and JoinGraph's directed graph has no `customers →
      // orders` edge. The error fires inside `BaseQuery.prebuildJoin` (called
      // from the constructor), so we wrap the constructor itself.
      const compilers = buildReverseViewCompiler();
      await compilers.compiler.compile();

      expect(() => new PostgresQuery(compilers, {
        measures: ['rev_view.count'],
        dimensions: ['rev_view.name'],
        timezone: 'UTC',
        useNativeSqlPlanner: false,
      })).toThrow(/Can't find join path/);
    });

    it('view with declared-direction join_path (orders.customers) works regardless of flag', async () => {
      // The forward direction works unconditionally — declared edge is used,
      // no synthesis needed, behavior matches pre-PR.
      const compilers = buildForwardViewCompiler();
      await compilers.compiler.compile();

      const query = new PostgresQuery(compilers, {
        measures: ['fwd_view.count'],
        dimensions: ['fwd_view.name'],
        timezone: 'UTC',
        useNativeSqlPlanner: false,
      });
      expect(() => query.buildSqlAndParams()).not.toThrow();
    });
  });

  // --- Gating: single flag drives the JS pipeline ---

  describe('single-flag gating', () => {
    it('CUBEJS_BIDIRECTIONAL_SQL_JOINS=true enables the feature without any other flag', async () => {
      // The JS pipeline (REST API, view join_path, BaseQuery) doesn't depend on
      // Tesseract or pushdown. The cubesql egraph applies a separate pushdown
      // gate for the `__cubeExplicitJoinField` SQL token, but that's tested in
      // the Rust side. Here we verify the JS path works with just the one flag.
      process.env.CUBEJS_BIDIRECTIONAL_SQL_JOINS = 'true';
      const { compiler, joinGraph } = buildOrdersCustomersCompiler('many_to_one');
      await compiler.compile();
      const tree = joinGraph.buildJoin([{ path: ['customers', 'orders'], explicit: true } as any]);
      expect(tree).not.toBeNull();
      expect(tree!.joins[0].synthetic).toBe(true);
    });

    it('CUBEJS_BIDIRECTIONAL_SQL_JOINS unset (default) keeps feature OFF', async () => {
      // No env vars set — strict pre-PR behavior.
      const { compiler, joinGraph } = buildOrdersCustomersCompiler('many_to_one');
      await compiler.compile();
      expect(() => joinGraph.buildJoin([{ path: ['customers', 'orders'], explicit: true } as any]))
        .toThrow(/Can't find join path/);
    });

    it('CUBEJS_BIDIRECTIONAL_SQL_JOINS=false keeps feature OFF', async () => {
      process.env.CUBEJS_BIDIRECTIONAL_SQL_JOINS = 'false';
      const { compiler, joinGraph } = buildOrdersCustomersCompiler('many_to_one');
      await compiler.compile();
      expect(() => joinGraph.buildJoin([{ path: ['customers', 'orders'], explicit: true } as any]))
        .toThrow(/Can't find join path/);
    });
  });
});

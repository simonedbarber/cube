import { prepareCompiler } from '@cubejs-backend/schema-compiler';
import { DuckDBInstance, type DuckDBValue } from '@duckdb/node-api';
import { DuckDBQuery } from '../../src/DuckDBQuery';

// Execute the actual generated SQL for both owners. This does not qualify the
// application's released Linux image or authorize a runtime admission change.
// Qualify PK sources explicitly: native automatic composite counts currently
// wrap bare PK SQL before auto-prefixing, a pre-existing planner limitation.
describe('automatic composite entity count', () => {
  it.each([false, true])('retains typed tuples under fanout (native=%s)', async useNativeSqlPlanner => {
    const { compiler, joinGraph, cubeEvaluator } = prepareCompiler({
      localPath: () => __dirname,
      dataSchemaFiles: async () => [{ fileName: 'main.js', content: `
        cube('parents', {
          sql_table: 'parents',
          joins: { children: { relationship: 'hasMany', sql: \`\${CUBE}.k1 = \${children}.k1 AND \${CUBE}.k2 = \${children}.k2\` } },
          dimensions: {
            k1: { sql: \`\${CUBE}.k1\`, type: 'string', primary_key: true },
            k2: { sql: \`\${CUBE}.k2\`, type: 'string', primary_key: true },
          },
          measures: { count: { type: 'count' } },
        });
        cube('children', {
          sql_table: 'children',
          dimensions: { id: { sql: 'id', type: 'number', primary_key: true }, label: { sql: 'label', type: 'string' } },
          measures: { count: { type: 'count' } },
        });
      ` }],
    }, { adapter: 'postgres' });
    await compiler.compile();

    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      await connection.run('CREATE TABLE parents(k1 VARCHAR, k2 VARCHAR); CREATE TABLE children(id INTEGER, k1 VARCHAR, k2 VARCHAR, label VARCHAR)');
      await connection.run(`INSERT INTO parents VALUES ('1','23'), ('12','3'), ('a|b','c'), ('a','b|c'), ('','x'), ('x',''), ('unmatched','tail'), (NULL,'tail'), ('head',NULL);
        INSERT INTO children SELECT ROW_NUMBER() OVER (), p.k1, p.k2, 'matched' FROM parents p CROSS JOIN range(2) WHERE p.k1 IS NOT NULL AND p.k1 <> 'unmatched'`);
      const query = new DuckDBQuery({ compiler, joinGraph, cubeEvaluator }, {
        measures: ['parents.count'], dimensions: ['children.label'], useNativeSqlPlanner,
      });
      const [sql, params] = query.buildSqlAndParams();
      expect(sql).toMatch(/COUNT\(DISTINCT CASE WHEN/i);
      expect(sql).toContain('THEN ROW(');
      expect(sql).toMatch(/THEN ROW\("parents"\.k1,\s*"parents"\.k2\)/);
      expect(sql).not.toContain(' || ');
      const rows = await (await connection.run(sql, params as DuckDBValue[])).getRowObjects();
      expect(rows.map(row => [row.children__label, Number(row.parents__count)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([['matched', 6], [null, 1]]);
      // The independent source oracle keeps keys as columns, without reusing
      // the production tuple renderer or concatenating component values.
      const truth = await (await connection.run('SELECT COUNT(*) AS entities FROM (SELECT DISTINCT k1, k2 FROM parents WHERE k1 IS NOT NULL AND k2 IS NOT NULL)')).getRowObjects();
      expect(Number(truth[0]!.entities)).toBe(7);
      await connection.run('DROP TABLE parents; DROP TABLE children; CREATE TABLE parents(k1 INTEGER, k2 VARCHAR); CREATE TABLE children(id INTEGER, k1 INTEGER, k2 VARCHAR, label VARCHAR)');
      await connection.run("INSERT INTO parents VALUES (1,'23'), (12,'3'); INSERT INTO children SELECT ROW_NUMBER() OVER (), p.k1, p.k2, 'matched' FROM parents p CROSS JOIN range(2)");
      const mixed = await (await connection.run(sql, params as DuckDBValue[])).getRowObjects();
      expect(mixed.map(row => [row.children__label, Number(row.parents__count)])).toEqual([['matched', 2]]);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });
});

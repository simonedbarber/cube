import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { DuckDBQuery } from '../../src/DuckDBQuery';

function correlationExpression(): string {
  return DuckDBQuery.prototype.sqlTemplates().functions.CORRELATION
    .replaceAll('{{ args_concat }}', 'x, y')
    .replaceAll('{{ args[0] }}', 'x')
    .replaceAll('{{ args[1] }}', 'y');
}

describe('DuckDB correlation source semantics', () => {
  let instance: DuckDBInstance;
  let connection: DuckDBConnection;

  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
    connection = await instance.connect();
    await connection.run(`CREATE TABLE paired_samples (cohort VARCHAR, x DOUBLE, y DOUBLE);
      INSERT INTO paired_samples VALUES
        ('positive', 1, 2), ('positive', 3, 6),
        ('positive', 100, NULL), ('positive', NULL, 200),
        ('negative', 1, 6), ('negative', 3, 2),
        ('singleton', 5, 9), ('singleton', NULL, 8),
        ('empty_pairs', NULL, 8), ('empty_pairs', 4, NULL),
        ('constant_x', 2, 1), ('constant_x', 2, 3),
        ('constant_x', 100, NULL),
        ('constant_y', 1, 2), ('constant_y', 3, 2),
        ('constant_y', NULL, 100),
        ('null_only', NULL, NULL);`);
  });

  afterAll(() => {
    connection?.closeSync();
    instance?.closeSync();
  });

  it('preserves paired correlations and returns NULL for undefined finite populations', async () => {
    // This method provides the actual source-dialect template. Substitution is
    // limited to its argument placeholders; native endpoint tests separately
    // verify the planner's rendering and policy binding.
    const expression = correlationExpression();
    const result = await connection.runAndReadAll(`SELECT cohort, ${expression} AS correlation
      FROM paired_samples GROUP BY cohort ORDER BY cohort`);
    // Independent centered products: {1,3} and {2,6} have correlation +1;
    // reversing the second pair gives -1. Empty, singleton and either constant
    // paired input have no defined correlation. One-sided NULL rows do not pair.
    expect(result.getRows()).toEqual([
      ['constant_x', null], ['constant_y', null], ['empty_pairs', null],
      ['negative', -1], ['null_only', null], ['positive', 1], ['singleton', null],
    ]);
  });

  it('retains a typed NULL for an entirely empty input', async () => {
    const expression = correlationExpression();
    const result = await connection.runAndReadAll(`SELECT ${expression} AS correlation
      FROM paired_samples WHERE FALSE`);
    expect(result.getRows()).toEqual([[null]]);
    expect(result.columnTypes().map(type => type.toString())).toEqual(['DOUBLE']);
  });

  it('does not turn a non-finite singleton into a missing finite observation', async () => {
    const source = "(VALUES (CAST('NaN' AS DOUBLE), 2::DOUBLE)) AS input(x, y)";
    const baseline = await connection.runAndReadAll(`SELECT CORR(x, y) FROM ${source}`);
    expect(Number.isNaN(Number(baseline.getRows()[0][0]))).toBe(true);
    const guarded = await connection.runAndReadAll(`SELECT ${correlationExpression()} FROM ${source}`);
    expect(Number.isNaN(Number(guarded.getRows()[0][0]))).toBe(true);
  });

  it.each(['NaN', 'Infinity', '-Infinity'])(
    'retains the source error for a non-finite %s observation in a pair',
    async nonfinite => {
      const source = `(VALUES (CAST('${nonfinite}' AS DOUBLE), 2::DOUBLE), (3, 6)) AS input(x, y)`;
      await expect(connection.runAndReadAll(`SELECT CORR(x, y) FROM ${source}`)).rejects.toThrow();
      await expect(connection.runAndReadAll(`SELECT ${correlationExpression()} FROM ${source}`)).rejects.toThrow();
    }
  );
});

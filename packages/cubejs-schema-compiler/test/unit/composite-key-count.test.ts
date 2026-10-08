import { BaseQuery } from '../../src/adapter/BaseQuery';
import { PostgresQuery } from '../../src/adapter/PostgresQuery';
import { RedshiftQuery } from '../../src/adapter/RedshiftQuery';
import { CrateQuery } from '../../src/adapter/CrateQuery';

const keys = ['parent.numeric_key', 'parent.text_key'];

describe('automatic composite entity count dialect contract', () => {
  it('keeps typed columns and excludes incomplete keys on PostgreSQL', () => {
    const sql = PostgresQuery.prototype.compositeKeySql.call(PostgresQuery.prototype, keys);
    expect(sql).toBe('CASE WHEN (parent.numeric_key) IS NOT NULL AND (parent.text_key) IS NOT NULL THEN ROW(parent.numeric_key, parent.text_key) END');
    expect(PostgresQuery.prototype.sqlTemplates.call(PostgresQuery.prototype).expressions.composite_key).toContain('THEN ROW(');
  });
  it.each([BaseQuery, RedshiftQuery, CrateQuery])('refuses composite count without the dialect tuple capability (%p)', Query => {
    expect(() => Query.prototype.compositeKeySql.call(Query.prototype, keys)).toThrow('COMPOSITE_KEY_COUNT_UNSUPPORTED');
    expect(Query.prototype.sqlTemplates.call(Query.prototype).expressions.composite_key).toBeUndefined();
  });
});

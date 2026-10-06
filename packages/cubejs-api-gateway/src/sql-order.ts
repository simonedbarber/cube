import type { NormalizedQuery } from './types/query';

/** Private SQL bridge metadata; public REST order remains two-tuples. Rewrites
 * must preserve both member identity and direction before positional attachment. */
export function withSqlOrderNullsFirst(query: NormalizedQuery, placement?: boolean[], sourceQuery?: unknown): NormalizedQuery {
  if (!placement?.length) return query;
  const source = typeof sourceQuery === 'string' ? JSON.parse(sourceQuery) : sourceQuery;
  const sourceOrder = source && typeof source === 'object' && 'order' in source ? source.order : undefined;
  if (!query.order || !Array.isArray(sourceOrder) || placement.length !== query.order.length ||
      placement.length !== sourceOrder.length || placement.some(value => typeof value !== 'boolean') ||
      query.order.some((term, index) => {
        const original = sourceOrder[index];
        return !Array.isArray(original) || original.length !== 2 || original[0] !== term.id ||
          (original[1] !== 'asc' && original[1] !== 'desc') || (original[1] === 'desc') !== term.desc;
      })) {
    throw new Error('SQL order null placement does not match the normalized order.');
  }
  return { ...query, order: query.order.map((term, index) => ({ ...term, nullsFirst: placement[index] })) };
}

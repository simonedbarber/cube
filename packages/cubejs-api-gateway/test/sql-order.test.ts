import { withSqlOrderNullsFirst } from '../src/sql-order';
import { normalizeQuery, remapToQueryAdapterFormat } from '../src/query';

describe('private SQL null placement transport', () => {
  it('survives actual REST normalization and adapter remapping without extending tuples', () => {
    const source = { measures: ['Orders.count'], order: [['Orders.count', 'desc']] };
    const normalized = normalizeQuery(source, false, undefined);
    expect(normalized.order).toEqual([['Orders.count', 'desc']]);
    const mapped = remapToQueryAdapterFormat(normalized);
    expect(withSqlOrderNullsFirst(mapped, [false], source).order)
      .toEqual([{ id: 'Orders.count', desc: true, nullsFirst: false }]);
  });
  it('preserves REST omission and differentiates every SQL direction/placement', () => {
    const omitted = { measures: ['Orders.count'], order: [{ id: 'Orders.count', desc: false }] };
    expect(withSqlOrderNullsFirst(omitted)).toBe(omitted);

    for (const desc of [false, true]) {
      for (const first of [false, true]) {
        const query = { measures: ['Orders.count'], order: [{ id: 'Orders.count', desc }] };
        const native = withSqlOrderNullsFirst(query, [first], { order: [['Orders.count', desc ? 'desc' : 'asc']] });
        expect(native.order).toEqual([{ id: 'Orders.count', desc, nullsFirst: first }]);
        expect(query.order).toEqual([{ id: 'Orders.count', desc }]);
        // Compiler query identity includes each normalized order object.
        expect(JSON.stringify(native)).not.toBe(JSON.stringify(withSqlOrderNullsFirst(query, [!first], { order: [['Orders.count', desc ? 'desc' : 'asc']] })));
      }
    }
  });
  it('rejects stale rewritten order metadata rather than associating it with another key', () => {
    expect(() => withSqlOrderNullsFirst({ measures: ['Orders.count'], order: [{ id: 'a', desc: false }, { id: 'b', desc: true }] }, [false])).toThrow('does not match');
    expect(() => withSqlOrderNullsFirst({ measures: ['Orders.count'], order: [{ id: 'a', desc: false }, { id: 'b', desc: true }] }, [true, false], { order: [['b', 'desc'], ['a', 'asc']] })).toThrow('does not match');
    expect(() => withSqlOrderNullsFirst({ measures: ['Orders.count'], order: [{ id: 'a', desc: false }] }, [true], { order: [['a', 'desc']] })).toThrow('does not match');
  });
});

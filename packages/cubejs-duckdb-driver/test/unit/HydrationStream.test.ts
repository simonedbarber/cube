import { transformRow } from '../../src/HydrationStream';

// transformRow normalizes a row's values into Cube's JS wire shape. It runs AFTER
// cubeValueConverter (which already formatted TIME/TIME_TZ/INTERVAL to strings and
// delegated the rest to neo's JS converter). Its job is:
//   - top-level number/bigint -> string (Cube serializes all numbers as strings)
//   - Date -> ISO timestamp
//   - bigints nested inside structs/lists/maps -> string (JSON.stringify throws on bigint)
// These tests exercise it directly with no DuckDB instance.
describe('transformRow', () => {
  test('top-level number and bigint become strings', () => {
    const row: any = { id: 42, count: 7n, name: 'x' };
    transformRow(row);
    expect(row).toEqual({ id: '42', count: '7', name: 'x' });
  });

  test('top-level Date becomes ISO timestamp', () => {
    const d = new Date('2020-01-01T01:01:01.111Z');
    const row: any = { created: d };
    transformRow(row);
    expect(row.created).toBe('2020-01-01T01:01:01.111Z');
  });

  test('null and undefined pass through', () => {
    const row: any = { a: null, b: undefined };
    transformRow(row);
    expect(row.a).toBeNull();
    expect(row.b).toBeUndefined();
  });

  test('already-formatted TIME/INTERVAL strings pass through unchanged', () => {
    // cubeValueConverter renders these to strings before the row reaches transformRow;
    // transformRow must not mangle them.
    const row: any = { t: '04:05:06', iv: '1 month 2 days 03:00:00' };
    transformRow(row);
    expect(row).toEqual({ t: '04:05:06', iv: '1 month 2 days 03:00:00' });
  });

  describe('nested bigints (the JSON.stringify regression)', () => {
    test('bigint nested inside a struct is stringified', () => {
      // A struct value like {'big': HUGEINT} arrives with a nested bigint that
      // JSON.stringify would throw on; transformRow must recurse and stringify it.
      const row: any = { s: { big: 9223372036854775807n, name: 'x' } };
      transformRow(row);
      expect(() => JSON.stringify(row)).not.toThrow();
      expect(row.s).toEqual({ big: '9223372036854775807', name: 'x' });
    });

    test('bigint nested inside a list is stringified', () => {
      const row: any = { l: [1n, 2n, 3n] };
      transformRow(row);
      expect(() => JSON.stringify(row)).not.toThrow();
      expect(row.l).toEqual(['1', '2', '3']);
    });

    test('deeply nested bigint (struct in a list) is stringified', () => {
      const row: any = { l: [{ n: 5n }, { n: 6n }] };
      transformRow(row);
      expect(() => JSON.stringify(row)).not.toThrow();
      expect(row.l).toEqual([{ n: '5' }, { n: '6' }]);
    });

    test('nested number is left as a JS number', () => {
      // The legacy driver never reached nested numbers; Cube treats already-parsed
      // nested numbers as JS values, so they are not stringified (only bigints are).
      const row: any = { l: [1, 2, 3] };
      transformRow(row);
      expect(row.l).toEqual([1, 2, 3]);
    });
  });

  test('Buffer is passed through (not recursed into)', () => {
    const buf = Buffer.from([1, 2, 3]);
    const row: any = { b: buf };
    transformRow(row);
    expect(Buffer.isBuffer(row.b)).toBe(true);
    expect(row.b).toBe(buf);
  });

  test('non-object / array row is a no-op', () => {
    expect(() => transformRow(null as any)).not.toThrow();
    expect(() => transformRow(undefined as any)).not.toThrow();
    expect(() => transformRow([1, 2] as any)).not.toThrow();
  });
});

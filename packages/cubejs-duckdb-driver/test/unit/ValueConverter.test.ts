import {
  BIGINT,
  DOUBLE,
  INTERVAL,
  JSDuckDBValueConverter,
  TIME,
  TIMETZ,
  TIMESTAMP,
  VARCHAR,
  DuckDBValueConverter,
  intervalValue,
  timeTZValue,
  timeValue,
  timestampValue,
} from '@duckdb/node-api';

import { cubeValueConverter } from '../../src/ValueConverter';

// cubeValueConverter is a DuckDBValueConverter<JS> that renders TIME / TIME_TZ / INTERVAL
// to display strings and delegates everything else to neo's built-in JSDuckDBValueConverter.
// These tests exercise it directly (no DuckDB instance) by constructing typed values and
// the matching DuckDBType singletons.
describe('cubeValueConverter', () => {
  // The converter signature is (value, type, converter); the third arg is the converter
  // itself, passed so neo can recurse into nested composites. Reuse cubeValueConverter.
  const conv: DuckDBValueConverter<any> = cubeValueConverter as any;

  describe('temporal composite types (formatted to display strings)', () => {
    test('TIME -> "04:05:06"', () => {
      const value = timeValue(BigInt(14_706_000_000)); // micros since midnight
      expect(conv(value, TIME, conv)).toBe('04:05:06');
    });

    test('TIME with sub-second precision is preserved', () => {
      const value = timeValue(BigInt(14_706_123_456)); // 04:05:06.123456
      expect(conv(value, TIME, conv)).toBe('04:05:06.123456');
    });

    test('TIME_TZ keeps its offset', () => {
      const value = timeTZValue(BigInt(14_706_000_000), 0); // micros, offset seconds
      expect(conv(value, TIMETZ, conv)).toMatch(/^04:05:06/);
    });

    test('INTERVAL -> "1 month 2 days 03:00:00"', () => {
      // (months, days, micros) — 3h = 3 * 3600 * 1e6 micros
      const value = intervalValue(1, 2, BigInt(3 * 3_600 * 1_000_000));
      expect(conv(value, INTERVAL, conv)).toBe('1 month 2 days 03:00:00');
    });
  });

  describe('delegation to the default JS converter', () => {
    test('TIMESTAMP value -> Date (so transformRow can render ISO)', () => {
      // timestampValue takes micros since epoch. 2020-01-01T00:00:00Z = 1577836800e6 micros.
      const value = timestampValue(BigInt(BigInt(1577836800) * BigInt(1_000_000)));
      const out = conv(value, TIMESTAMP, conv);
      expect(out).toBeInstanceOf(Date);
      expect((out as Date).toISOString()).toBe('2020-01-01T00:00:00.000Z');
    });

    test('BIGINT value -> bigint', () => {
      // The JS converter returns a native bigint; transformRow stringifies it downstream.
      const out = conv(42n, BIGINT, conv);
      expect(typeof out).toBe('bigint');
      expect((out as bigint).toString()).toBe('42');
    });

    test('DOUBLE value -> number', () => {
      const out = conv(1.5, DOUBLE, conv);
      expect(out).toBe(1.5);
    });

    test('VARCHAR value -> string', () => {
      const out = conv('hello', VARCHAR, conv);
      expect(out).toBe('hello');
    });

    test('null -> null', () => {
      expect(conv(null, TIME, conv)).toBeNull();
      expect(conv(null, BIGINT, conv)).toBeNull();
    });
  });

  describe('matches the contract of JSDuckDBValueConverter for non-temporal types', () => {
    // The converter must be observationally identical to the built-in JS converter for
    // every type it delegates (otherwise the driver's output would diverge from the
    // upstream PR #11165 behavior for the common types).
    test('BIGINT/DOUBLE/VARCHAR agree with JSDuckDBValueConverter', () => {
      for (const [val, type] of [
        [42n, BIGINT],
        [1.5, DOUBLE],
        ['hello', VARCHAR],
      ] as const) {
        expect(conv(val, type, conv)).toEqual(JSDuckDBValueConverter(val, type, JSDuckDBValueConverter));
      }
    });
  });
});

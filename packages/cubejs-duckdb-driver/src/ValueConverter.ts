import {
  DuckDBType,
  DuckDBTypeId,
  DuckDBValue,
  DuckDBValueConverter,
  JS,
  JSDuckDBValueConverter,
} from '@duckdb/node-api';

/**
 * A DuckDBValueConverter that preserves Cube's JS wire contract for the temporal
 * composite types that @duckdb/node-api's built-in JS converter flattens to
 * bigint-bearing values (which JSON.stringify cannot serialize).
 *
 * Why this exists: `getRowObjectsJS()` / `yieldRowObjectJs()` discard column type
 * metadata and reduce every value to a JS built-in. For TIME that means a bare
 * bigint (micros since midnight) indistinguishable from BIGINT; for TIME_TZ /
 * INTERVAL it means `{ micros: bigint, ... }` objects whose nested bigint crashes
 * JSON.stringify. This converter receives `(value, type)` — so the type context
 * the JS path throws away is available — and renders those three types to their
 * DuckDB display strings (e.g. `04:05:06`, `04:05:06-05`, `1 month 2 days 03:00:00`)
 * via the typed value's own `toString()`. Everything else is delegated to neo's
 * default `JSDuckDBValueConverter` (Date for TIMESTAMP, bigint for BIGINT, number
 * for DOUBLE, etc.), which the driver's `transformRow` then normalizes to Cube's
 * final shape (ISO timestamps, stringified numbers/bigints).
 *
 * The converter is invoked recursively for values nested inside structs / lists /
 * maps, so a TIME buried in a composite column is also formatted correctly.
 */
export const cubeValueConverter: DuckDBValueConverter<JS> = (
  value: DuckDBValue,
  type: DuckDBType,
  converter: DuckDBValueConverter<JS>,
): JS => {
  if (value === null || value === undefined) {
    return null;
  }

  // TIME / TIME_TZ / INTERVAL arrive as typed DuckDBValue objects whose toString()
  // yields the canonical DuckDB display form. The JS converter instead reduces them
  // to a bigint (TIME) or a bigint-bearing object (TIME_TZ / INTERVAL).
  if (
    type.typeId === DuckDBTypeId.TIME
    || type.typeId === DuckDBTypeId.TIME_TZ
    || type.typeId === DuckDBTypeId.INTERVAL
  ) {
    return (value as { toString: () => string }).toString();
  }

  // Default: neo's built-in JS conversion (Date, bigint, number, string, ...).
  // DuckDBValueConverter is typed as (value, type, converter) => T; pass the same
  // converter down so neo can recurse into nested structs/lists/maps for us.
  return JSDuckDBValueConverter(value, type, converter);
};

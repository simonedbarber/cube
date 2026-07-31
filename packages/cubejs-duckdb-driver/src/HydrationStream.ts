import stream, { TransformCallback } from 'stream';

// Recursively normalizes nested values (inside structs/lists/maps) so they are
// JSON-serializable: bigints -> string. Numbers nested inside composites are left as-is
// (the legacy driver never reached them, and Cube treats already-parsed nested numbers
// as JS values). Plain objects/arrays are descended into in place.
function normalizeNested(value: any): any {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      value[i] = normalizeNested(value[i]);
    }
    return value;
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      value[key] = normalizeNested(value[key]);
    }
    return value;
  }
  return value;
}

// Top-level scalar fields keep the legacy contract: number/bigint -> string, Date -> ISO.
// Anything composite (object/array) is normalized recursively so any nested bigints are
// JSON-safe. (TIME/TIME_TZ/INTERVAL never reach here as objects — cubeValueConverter
// formats them to strings before the row is returned.)
function normalizeScalar(value: any): any {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toString();
  }
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return (value as Date).toISOString();
  }
  return normalizeNested(value);
}

/**
 * Recursively normalizes a row's values into Cube's JS wire shape.
 *
 * The DuckDB driver reads rows via a custom DuckDBValueConverter (cubeValueConverter)
 * that formats TIME / TIME_TZ / INTERVAL to strings and delegates the rest to neo's
 * default JS conversion. The delegated values still need normalization:
 *   - top-level number/bigint -> string (Cube serializes all numbers as strings)
 *   - Date -> ISO timestamp
 *   - bigints nested inside structs/lists/maps -> string (JSON.stringify throws on
 *     bigint, and the delegated converter returns bigint for nested BIGINT columns)
 *
 * The legacy `duckdb` driver only flattened top-level scalars; @duckdb/node-api returns
 * bigints (and bigint-bearing values nested in composites), so the recursion here is
 * what keeps the row JSON-serializable.
 */
export function transformRow(row: any): void {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return;
  }
  for (const field of Object.keys(row)) {
    row[field] = normalizeScalar(row[field]);
  }
}

export class HydrationStream extends stream.Transform {
  public constructor() {
    super({
      objectMode: true,
      transform(row: any, encoding: BufferEncoding, callback: TransformCallback) {
        transformRow(row);

        this.push(row);
        callback();
      }
    });
  }
}

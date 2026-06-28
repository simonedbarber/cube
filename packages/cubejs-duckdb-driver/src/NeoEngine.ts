// ─────────────────────────────────────────────────────────────────────────────
// NeoEngine — DuckDB execution routed through @duckdb/node-api (neo) v1.5.3.
//
// QueryRails (Epic 27, Milestone A — task 27.12b). WHY THIS FILE EXISTS:
//
// The stock @cubejs-backend/duckdb-driver bundles classic `duckdb` (npm `duckdb`),
// whose DuckLake extension only understands catalog format <= 0.3. The Epic-27
// lake WRITER (apps/worker) writes the lake via @duckdb/node-api@1.5.3 → DuckLake
// catalog format > 0.3, which the classic engine CANNOT attach (verified). Classic
// `duckdb` has no 1.5.x release; only @duckdb/node-api ("neo") does. So the driver's
// query + connection execution is routed through neo@1.5.3 — fixing BOTH readers
// (Cube + API) at once, with the existing routing unchanged.
//
// DESIGN: keep the neo specifics HERE behind a tiny adapter that exposes the SAME
// shape the stock DuckDBDriver expects from classic `duckdb`:
//   - openEngine(dbUrl, options) → { defaultConnection, db } where
//       defaultConnection.execAsync(sql)            (statement script runner)
//       defaultConnection.allAsync(sql, ...values)  (returns row objects)
//       defaultConnection.streamAsync(sql, values)  (Readable of row objects)
//       db.closeAsync()                             (close the instance)
//
// neo API used (see @duckdb/node-api@1.5.3 typings + apps/worker/src/lib):
//   DuckDBInstance.create(path, options) / instance.connect()
//   conn.run(sql)                                       — run a statement
//   conn.runAndReadAll(sql, values).getRowObjectsJS()   — materialized rows as JS
//   conn.streamAndReadUntil(sql, n, values)             — chunked reader
//   conn.closeSync() / instance.closeSync()
// ─────────────────────────────────────────────────────────────────────────────
import * as stream from 'stream';

export interface NeoConnection {
  // Runs a whole (possibly multi-statement) SQL script; REJECTS on the first failure.
  execAsync(sqlScript: string): Promise<void>;
  // Materialized query → array of plain JS row objects.
  allAsync<R = any>(sql: string, ...values: any[]): Promise<R[]>;
  // Streaming query → Node Readable of plain JS row objects (chunked).
  streamAsync(sql: string, values: any[], highWaterMark?: number): stream.Readable;
  closeSync(): void;
}

export interface NeoDb {
  instance: any;
  closeAsync(): Promise<void>;
}

// Lazy require so the bundled classic `duckdb` is never loaded on the lake path,
// and so a missing neo dependency surfaces a clear error only when used.
function loadNeo(): any {
  // eslint-disable-next-line global-require
  return require('@duckdb/node-api');
}

// neo's `run` executes one statement; the classic driver hands whole SQL scripts
// (multi-line `initSql`, or `INSTALL a; INSTALL b;`) to a single exec call. Split
// on top-level semicolons (respecting quotes/comments) and run each in order, so a
// script with N statements maps to N `run` calls.
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') { current += next; i += 1; inBlockComment = false; }
      continue;
    }
    if (!inSingle && !inDouble && ch === '-' && next === '-') {
      inLineComment = true; current += ch; continue;
    }
    if (!inSingle && !inDouble && ch === '/' && next === '*') {
      inBlockComment = true; current += ch; continue;
    }
    if (!inDouble && ch === "'") { inSingle = !inSingle; current += ch; continue; }
    if (!inSingle && ch === '"') { inDouble = !inDouble; current += ch; continue; }
    if (ch === ';' && !inSingle && !inDouble) {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/**
 * Open a neo engine + default connection, exposing a classic-`duckdb`-shaped
 * surface the stock driver's init() / query() / stream() / release() consume.
 *
 * @param dbUrl ':memory:' for the lake path (the lake is reached via ATTACH … AS
 *   lake inside initSql), or a real path/md: URL for non-lake.
 * @param options neo instance options.
 */
export async function openEngine(
  dbUrl: string,
  options?: Record<string, any>,
): Promise<{ defaultConnection: NeoConnection; db: NeoDb }> {
  const neo = loadNeo();
  const instance = await neo.DuckDBInstance.create(dbUrl, options || {});
  const connection = await instance.connect();

  // Run a whole SQL script as classic `exec` would. Each statement runs in order;
  // the FIRST failure REJECTS (no swallowing — the stock driver swallowed
  // initSql/ATTACH failures, producing silent no-attach and misleading
  // "Table does not exist"; this fixes that).
  async function execAsync(sqlScript: string): Promise<void> {
    const statements = splitStatements(String(sqlScript));
    for (const statement of statements) {
      // eslint-disable-next-line no-await-in-loop
      await connection.run(statement);
    }
  }

  // Materialized query → array of plain JS row objects, matching classic
  // `connection.all(...)`'s output that HydrationStream.transformRow normalizes.
  async function allAsync<R = any>(sql: string, ...values: any[]): Promise<R[]> {
    const reader = await connection.runAndReadAll(sql, values.length ? values : undefined);
    return reader.getRowObjectsJS();
  }

  // Streaming query → async iterator of plain JS row objects, read in chunks so
  // large pre-aggregation reads do not materialize fully in memory.
  async function* streamRows(sql: string, values: any[]): AsyncGenerator<any> {
    const CHUNK = 1000;
    const reader = await connection.streamAndReadUntil(
      sql,
      CHUNK,
      values && values.length ? values : undefined,
    );
    let emitted = 0;
    for (;;) {
      const rows = reader.getRowObjectsJS();
      for (let i = emitted; i < rows.length; i += 1) {
        yield rows[i];
      }
      emitted = rows.length;
      if (reader.done) break;
      // eslint-disable-next-line no-await-in-loop
      await reader.readUntil(emitted + CHUNK);
      const after = reader.getRowObjectsJS();
      if (after.length === emitted && reader.done) break;
      if (after.length === emitted && !reader.done) {
        // No progress but not done — defensive guard against a tight loop.
        // eslint-disable-next-line no-await-in-loop
        await reader.readAll();
      }
    }
    // Drain any remaining rows after the readAll fallback.
    const finalRows = reader.getRowObjectsJS();
    for (let i = emitted; i < finalRows.length; i += 1) {
      yield finalRows[i];
    }
  }

  function streamAsync(sql: string, values: any[], highWaterMark?: number): stream.Readable {
    const iterator = streamRows(sql, values);
    return stream.Readable.from(iterator, { highWaterMark });
  }

  return {
    defaultConnection: {
      execAsync,
      allAsync,
      streamAsync,
      closeSync: () => {
        try { connection.closeSync(); } catch (e) { /* best-effort */ }
      },
    },
    db: {
      instance,
      closeAsync: async () => {
        try { connection.closeSync(); } catch (e) { /* best-effort */ }
        try { instance.closeSync(); } catch (e) { /* best-effort */ }
      },
    },
  };
}

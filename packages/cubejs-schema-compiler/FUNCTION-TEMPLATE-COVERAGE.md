# SQL function-template pushdown — coverage matrix

This documents the SQL **function-template pushdown** behaviour for statistical /
math / string functions across dialects, and the QueryRails fixes applied to it.

## Root cause that was fixed

When cubesql / Tesseract push a function down to the source DB, they look up a
Jinja template at key `functions/<LOOKUP_KEY>`. `<LOOKUP_KEY>` is the **UPPERCASE
of the DataFusion CamelCase enum variant name, with NO underscores** — aggregates
use `AggregateFunction::to_string()` as-is (`service.rs`), scalars are uppercased.
So `StddevPop → STDDEVPOP`, `Variance → VARIANCE`, `Covariance → COVARIANCE`,
`Correlation → CORRELATION`, `PercentileCont → PERCENTILECONT`, `Log10 → LOG10`,
`BitLength → BITLENGTH`, etc.

The base map (`BaseQuery.js sqlTemplates().functions`) historically keyed the
statistical family by **SQL spelling** (`STDDEV_POP`, `VAR_POP`, `COVAR_SAMP`,
`DLOG10`, …). Those keys are **never produced** by the lookup, so the functions
were silently dropped from push-down (`can_rewrite_template` returns false → the
wrapper rewrite is skipped → the query errors with a misleading
"unknown_aggregation_type" / "Can't detect Cube query"). `STDDEV_SAMP` and
`PERCENTILE_CONT` worked only because their correct Display-name keys (`STDDEV`,
`PERCENTILECONT`) happened to exist.

**Fix:** the base map now also defines the real Display-name keys (`STDDEVPOP`,
`VARIANCE`, `VARIANCEPOP`, `COVARIANCE`, `COVARIANCEPOP`, `CORRELATION`, `LOG10`,
`TRIM`, `BITLENGTH`, `OCTETLENGTH`, `STARTSWITH`). The old SQL-spelling keys are
left as inert aliases. The same map drives both cubesql and the Tesseract planner.

### Two-argument aggregates (CORR, COVAR_*) — Rust change

The cubesql wrapper rewrite rules only matched **single-argument** aggregates
(`agg_fun_expr(?fun, vec![?expr], …)`), so two-arg aggregates (`CORR`, `COVAR_SAMP`,
`COVAR_POP`) never matched and failed before the template lookup. Additive 2-arg
push-down/pull-up rules were added in
`rust/cubesql/.../rules/wrapper/aggregate_function.rs` (the template alone is not
sufficient for these — the rewriter must match the 2-arg shape).

## Coverage matrix

Legend: **D** = base template works as-is · **O** = per-dialect override (native
form) · **X** = deleted / abstain (unsupported). Dialects with their own
`*Query.ts` class are listed; inheritors (CockroachDB→Postgres, Materialize→Postgres,
MariaDB/TiDB/SingleStore/StarRocks→MySQL, Microsoft Fabric→MSSQL) follow their
parent. DuckDB/MotherDuck and Dremio are all-D for the in-scope set.

| fn | PG | Redshift | Crate | DuckDB | MySQL | MSSQL | ClickHouse | Snowflake | Oracle | BigQuery | Presto | Trino | Athena | Hive | Vertica | SQLite | Druid | Firebolt | Pinot | ksql |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| STDDEV_SAMP | D | D | D | D | D | O `STDEV` | D | D | D | D | D | D | D | D | D | X | D | D | D | D |
| STDDEV_POP | D | D | D | D | D | O `STDEVP` | D | D | D | D | D | D | D | D | D | X | D | D | D | X |
| VAR_SAMP | D | D | X | D | D | O `VAR` | D | D | D | D | D | D | D | D | D | X | D | D | D | X |
| VAR_POP | D | D | O `VARIANCE` | D | D | O `VARP` | D | D | D | D | D | D | D | D | D | X | D | D | D | X |
| COVAR_SAMP | D | X | X | D | X | X | D | D | D | D | D | D | D | D | D | X | X | D | D | X |
| COVAR_POP | D | X | X | D | X | X | D | D | D | D | D | D | D | D | D | X | X | D | D | X |
| CORR | D | X | X | D | X | X | O `corr` | D | D | D | D | D | D | D | D | X | X | D | X | O `CORRELATION(a,b)` |
| PERCENTILE_CONT | D | D | X | D | X | X | X | D | D | X | X | X | X† | X | X | X | X | D | X | X |
| LOG10 | D | O `LOG(10,x)` | O `LOG(x)` | D | D | D | D | O `LOG(10,x)` | O `LOG(10,x)` | D | D | D | D | D | D | D | D | D | D | O `LOG(10,x)` |
| ATAN2 | D | D | D | D | D | O `ATN2` | D | D | D | D | D | D | D | X | D | D | D | D | D | D |
| COT | D | D | D | D | D | D | X | D | X | D | O `1/TAN` | X | X† | X | D | X | D | D | D | D |
| DEGREES | D | D | D | D | D | D | D | D | X | X | D | D | D | D | D | D | D | D | D | D |
| RADIANS | D | D | D | D | D | D | D | D | X | X | D | D | D | D | D | D | D | D | D | D |
| CHAR_LENGTH | D | D | D | D | D | O `LEN` | O `lengthUTF8` | O `LENGTH` | O `LENGTH` | D | O `LENGTH` | O `length` | O `length` | D | D | O `LENGTH` | D | X | D | O `LEN` |
| TRIM | D | D | D | D | D | D | O `trimBoth` | D | D | D | D | D | D | D | D | D | D | D | D | D |
| BIT_LENGTH | D | X | D | D | D | X | X | D | X | X | D | X | X | X | D | X | X | X | D | X |
| OCTET_LENGTH | D | D | D | D | D | X | D | D | O `LENGTHB` | D | X | X | X | D | D | D | X | D | D | X |
| STARTS_WITH | D | X | D | D | X | X | O `startsWith` | O `STARTSWITH(a,b)` | X | D | D | D | D | X | X | X | X | X | O `STARTSWITH` | X |

† Athena inherits Presto's `PERCENTILE_CONT` and `COT` handling via class inheritance.

## Residuals / known follow-ups

- **`PERCENTILE_CONT` is DEFAULT only for standard `WITHIN GROUP (ORDER BY)`
  dialects** (Postgres, DuckDB, Oracle, Snowflake, Redshift, Databricks). For
  parametric/non-`WITHIN GROUP` dialects (ClickHouse `quantileExactInclusive`,
  Pinot `PERCENTILE(col, p*100)`, SQLite/Crate 2-arg) it is **deleted (abstain)**:
  the shared `expressions/within_group` wrapper unconditionally appends
  `WITHIN GROUP (ORDER BY …)`, which those parametric forms cannot accept. Enabling
  them requires a per-dialect `within_group` expression override (not done here).
- **Window-only `PERCENTILE_CONT`** (MSSQL, BigQuery, Vertica) is deleted — those
  engines support it only as an `OVER()` analytic function, not as a `WITHIN GROUP`
  aggregate.
- **MariaDB ColumnStore** covar/corr support is a deferred follow-up (a
  `CUBEJS_DB_MYSQL_ENGINE=columnstore` gate that re-enables COVAR_*/CORR on the
  MySQL dialect).
- **Two-argument aggregates** push down only via the new Rust wrapper rules; the
  templates above (`CORRELATION`, `COVARIANCE`, `COVARIANCEPOP`) are also correct
  for the Tesseract / modeled-measure paths.
- Only **DuckDB / PostgreSQL / MySQL** are live-validated (the deployed engines);
  the rest are documentation- and unit-test-verified.

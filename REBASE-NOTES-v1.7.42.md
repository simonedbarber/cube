# Fork rebase notes — upstream v1.7.42

Branch: `codex/rebase-v1.7.42-clean`
Base tag: **v1.7.42** (`919434f42b50183179e97d1eed85696bafb05ae2`, 2026-09-18) — the
latest upstream release tag; no `v1.8.x` exists.
Previous fork branch: `codex/rebase-v1.7.26-clean` (`672620b1b9`), 19 linear commits
on top of v1.7.26.

## Method: cherry-pick, not rebase

The v1.7.26 branch is linear (no merge commits), so a `git rebase --onto v1.7.42`
was possible. It was NOT used, because 6 of the 19 commits had to be dropped
outright (below) and a straight rebase would have replayed the fork's whole
`@duckdb/node-api` port onto upstream's own port of the same driver — a conflict
with no useful resolution. Cherry-picking the surviving delta gives the same
linear history with an explicit, reviewable keep/drop decision per commit.

## Commits carried

| v1.7.26 commit | New commit | Note |
| --- | --- | --- |
| `457342039d` fix(tesseract): dedup cube names for dimension-only measure expressions | `afe9cf8bda` | test-only; clean apply |
| `672620b1b9` test(qr): update v1.7.26 multiplication diagnostic | `8b629ee379` | clean apply |
| `40e55a4250` fix(schema-compiler): allow number_agg measures without multi_stage | `b6f3701ef1` | clean apply |
| `820e8ba13d` feat(schema-compiler): SQL function-template dead keys + per-dialect overrides | `0a1152d09a` | 4 conflicts, see below |
| `be69c6a057` fix(qr): merge v1.7.26 dialect template overrides | `eb3b79cf6f` | 1 conflict, see below |
| `147a50c66f` chore: ignore .zcode/ | `a6cf2fe192` | clean apply |
| `6b051e362a` + 6 CI commits + the Dockerfile half of `7023bec8f9` | `146702fcd1` | squashed and rewritten for 1.7.42 |
| the initSql fail-fast inside `21446947df` / `31a35a28de` | `761b576bf7` | re-applied by hand to upstream's driver |

Plus `style(qr)` (oxlint) and a `docs(schema-compiler)` correction to
`FUNCTION-TEMPLATE-COVERAGE.md`.

## Commits dropped (upstream absorbed them)

- `989ad27b3c` + `626b7850e0` — cubesql two-argument aggregate push-down.
  Upstream generalised the *same* rules to a variadic argument list
  (`agg_fun_expr_var_arg`, plus `wrapper-{push-down,pull-up}-aggregate-function-args`
  and the empty-tail rule) in `rules/wrapper/aggregate_function.rs`, with
  `test_wrapper_multi_arg_aggregate_function` as coverage. The fork's two-arg
  special case is strictly subsumed. **The fork now has no Rust source delta at
  all** — only two test files in `cubesqlplanner/src/tests/`.
- `21446947df`, `31a35a28de`, `97263ecb4f`, and the dependency half of `7023bec8f9`
  — the `@duckdb/node-api` (neo) port of the DuckDB driver and its test suite.
  Upstream absorbed the port as #11910 (v1.7.41) and pins
  `@duckdb/node-api@1.5.5-r.5` as a real driver dependency, with its own
  `RowStream.ts` / `Transform.ts` and 43 unit tests. The fork's `NeoEngine.ts`,
  `ValueConverter.ts` and `HydrationStream` changes are gone; upstream's
  `Transform.ts` covers the same TIME / TIMETZ / INTERVAL rendering.
  `yarn.lock` is therefore pristine v1.7.42 — the fork carries no lockfile delta.

## Conflicts and how they were resolved

1. **`BaseQuery.js` `functions` map** (expected clash with #11684). Auto-merged.
   Verified all 11 fork keys (`STDDEVPOP`, `VARIANCE`, `VARIANCEPOP`, `COVARIANCE`,
   `COVARIANCEPOP`, `CORRELATION`, `LOG10`, `TRIM`, `BITLENGTH`, `OCTETLENGTH`,
   `STARTSWITH`) are **still absent upstream** at v1.7.42, so none had to yield to
   an upstream definition. Upstream's window templates (`LAG`, `LEAD`,
   `FIRST_VALUE`, `LAST_VALUE`, `NTH_VALUE`, …) and `APPROXPERCENTILECONT` are all
   kept. The merged map has 81 keys, 0 duplicates.
2. **`DruidQuery.ts`, `KsqlQuery.ts`, `MssqlQuery.ts`, `PrestodbQuery.ts`** —
   adjacency conflicts only (upstream added `delete templates.statements.union`,
   `delete templates.functions.NTH_VALUE`, `APPROXPERCENTILECONT`, right where the
   fork appends its overrides). Resolved as a **union**, upstream lines first. No
   dialect file has a duplicate `templates.functions.X` assignment.
3. **`SqliteQuery.ts`** — upstream now defines a second `sqlTemplates()` carrying
   `delete templates.statements.union`. Two method definitions of the same name in
   one class means the LAST wins, which would have silently discarded the fork's
   whole override block. Merged upstream's body into the fork's single
   `sqlTemplates()` and deleted the duplicate. `CrateQuery.ts` and `OracleQuery.ts`
   had the same duplicate-method shape (inherited from the v1.7.26 rebase) and were
   fixed by the same cherry-picked commit.
4. **`initSql` fail-fast** — re-written by hand against upstream's node-api
   `DuckDBDriver.ts`. Two behaviour changes vs upstream:
   - `initSql` failure THROWS instead of logging `"(skipping)"`. Upstream's init
     path already closes the connection then the instance on throw and allows a
     retry, so no extra teardown was needed.
   - `INSTALL ducklake; INSTALL postgres; INSTALL httpfs;` runs before `initSql`,
     **gated on the initSql referencing `ducklake`** (`/\bducklake\b/i`). The
     v1.7.26 fork ran this unconditionally; at v1.7.42 that would fire a
     network-bound extension install inside upstream's real-DuckDB unit test
     (`DuckDBDriver.test.ts` 'initializes lazily once…' uses a plain `initSql`).
     The gate keeps the lake behaviour identical and leaves generic `initSql`
     untouched.
   Upstream's `DuckDBInitialization.test.ts` test `continues after setting and
   initSql errors` encoded the swallow; it is rewritten as `fails fast when initSql
   errors, and still ignores setting errors`, plus two new tests for the gated
   install.

## CI / Dockerfile changes (file references only — nothing was run)

`packages/cubejs-docker/qr-base.Dockerfile`:
- `CUBE_VERSION` `v1.7.26` → `v1.7.42`; builder node `24.18.0` → `24.21.0`.
- **Removed the Rust toolchain and the whole native-addon build.** It existed only
  for the two-arg push-down, which is now upstream, so the official image's native
  addon is the right one.
- **Removed `npm install --no-save @duckdb/node-api@1.5.5-r.3`.** Upstream's driver
  now depends on `@duckdb/node-api@1.5.5-r.5` and `latest.Dockerfile` installs it
  (it even prunes the musl bindings), so the manual install would DOWNGRADE it.
- Overlay list unchanged and still correct: `schema-compiler`, `duckdb-driver`,
  `druid-driver`, `firebolt-driver`, `pinot-driver`, `ksql-driver` — exactly the six
  packages with a fork delta. Checked against #11838 (named ESM exports): that PR
  adds an `exports` map to the driver package.json files, and every overlaid package
  either has no `exports` map (`schema-compiler`, `druid-driver`) or routes
  `./dist/*` through it, so a `dist`-only overlay onto the official image still
  resolves. The image's package.json is upstream's and is not overlaid.

`.github/workflows/qr-build-base.yml`:
- default `cube_version` and both `v=${IN:-…}` fallbacks → `v1.7.42`.
- push trigger branch `feat/2arg-agg-pushdown` → `codex/rebase-v1.7.42-clean`.
- **Removed the "Prepare build context (include rust source)" step.** It rewrote
  `.dockerignore` to widen the context for the Rust build; the repo's default
  `.dockerignore` (which already un-ignores `packages/`, the workspace manifests and
  the lockfile) is sufficient now and gives a much smaller context.
- YAML re-validated with a parser. No workflow was triggered.

## Tests run

Environment: macOS, node v24.20.0, yarn 1.22.19, `yarn install --frozen-lockfile`
(the `@cubejs-backend/cubestore` post-install fails to download its binary and the
optional `java` native build fails without a JDK — neither is used by these suites).

| Suite | Command | Result |
| --- | --- | --- |
| schema-compiler unit, **Tesseract on** | `TZ=UTC CUBEJS_TESSERACT_SQL_PLANNER=true jest dist/test/unit` | **936 passed, 30 failed, 966 total** |
| same, on pristine **v1.7.42** (baseline) | as above | **935 passed, 30 failed, 965 total** |
| schema-compiler unit, Tesseract off | `TZ=UTC jest dist/test/unit` | 936 passed, 30 failed — byte-identical failure set |
| joins / views / extends / multi-fact / validator, Tesseract on | `jest extends-shared-definitions views duplicate-cube-joins multi-fact-derived-measure-in-view cube-validator join-hints-cache-pollution` | **157 passed, 0 failed** |
| duckdb-driver unit | `NODE_OPTIONS=--experimental-vm-modules jest dist/test/unit` | **43 passed, 0 failed** (4 suites) |
| pinot-driver unit | `jest dist/test/unit` | 9 passed |
| ksql-driver unit | `jest dist/test/unit` | 7 passed |
| oxlint, all changed packages | `npx oxlint <changed dirs>` | clean (2 findings found and fixed) |

The 30 failures are **identical, test name for test name, to the v1.7.42 baseline**
— 7 pre-existing upstream reds in `base-query`, `error-reporter`,
`filter-params-callback-column`, `filter-params-time-shifts`,
`pre-agg-interpolated-cube-refs`, `pre-aggregations`,
`raw-time-dimension-timezone`. They fail with Tesseract on AND off (those suites
force the native planner internally), so they are not a Tesseract-pin artefact and
not caused by this rebase. The +1 passing test on the branch is the fork's
`number_agg` validator test.

One earlier run showed 3 extra failures in `extends-shared-definitions` — all three
were jest's 5000 ms per-test timeout under CPU contention (that run took 108 s vs
47 s). Re-run in isolation the suite is green; the clean full re-run matches the
baseline exactly.

## Not run / unresolved

- **Integration tests did not run.** `test/integration/postgres/*` needs
  testcontainers, and Docker is not running on this machine. Deliberately not
  started (the environment's services are user-owned). So
  `multi-fact-join.test.ts` — whose body is guarded by
  `if (!getEnv('nativeSqlPlanner'))` and early-returns when Tesseract is off —
  is **unverified**; the guard was read and confirmed present at line 99, but the
  test was not executed. It must run under `CUBEJS_TESSERACT_SQL_PLANNER=true`
  with Docker available before this branch is trusted for the join work.
- **The Rust test suite did not run.** The two carried test files
  (`cubesqlplanner/src/tests/member_expressions_on_views.rs`) are the fork's only
  remaining `rust/` delta; upstream has not touched that file since v1.7.26, so
  they applied cleanly, but `cargo test -p cubesqlplanner` was not executed.
- **No Docker image was built and nothing was pushed.** `qr-base.Dockerfile` is a
  file-level update only; the FROM tag `cubejs/cube:v1.7.42-jdk` is assumed to
  exist by analogy with the v1.7.26 lane and was not verified against the registry.
- Upstream #11913 (query() RSS regression, v1.7.42) is inherited as-is. The plan's
  "prefer `stream()` over `query()`" guidance is a QueryRails-side change and is
  not part of this branch.
- 1.7.40 (#11809) makes duplicate joins a compile ERROR. Nothing in the fork
  changes join handling, but generated models must be audited before the pinned
  image moves.

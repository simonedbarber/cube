# Native semantic SQL source fixtures

After building the native addon and referenced workspaces, run the package's
`unit:semantic-sql` command. It sets `CUBESQL_STREAM_MODE=true` before Jest starts:
Jest's virtual `process.env` cannot select the Rust addon's OS-level configuration.
The package's ordinary `unit` command remains separate.

These fixtures use an owned HTTP listener, the actual gateway/compiler/native
planner, in-memory DuckDB, the driver's conversion and row stream, and the
orchestrator's existing `QueryStream` alias mapping. They record source SQL,
columns, row counts and completed streaming reads. Scheduling and source-result
caching are omitted; fixture grants do not establish application source/product
authority. Teardown closes the listener and database and awaits stream closure.
The semantic command lets Jest exit naturally. A passing numerical run alone
does not establish the broader process-shutdown or resource matrix.

`aligned-component-canonical-sql.json` preserves six QueryRails emission-revision-3
development queries and independent expected results. Its captured K=50,000 is a
regression input, not a platform limit default. Both large cases read 55,000 base
groups, 55,001 component groups and all 110,001 aligned keys before final filtering
or paging. The fixture validates unzoned native Timestamp cells under its explicit
UTC query contract rather than interpreting them in the host timezone.

`retained-totals-canonical-sql.json` preserves eight QueryRails development
queries using ordinary declared distributive SUM, COUNT, MIN and MAX measures.
Detail paging is pushed to source SQL and reads a bounded result. Each independent
total instead streams every HAVING-retained group without LIMIT or OFFSET: 60,001
groups for the large global total and 10,001 after its restrictive HAVING. Empty
detail does not remove the total; empty retained input preserves NULL aggregates
and COUNT zero. COUNT retains its Int64 wire type. These fixtures do not establish
weighted-state or distinct/disjoint composition eligibility.

`nonadditive-source-totals-canonical-sql.json` preserves nine current public
source-recomputation targets and an explicit finalized-group control. Native AVG,
SUM, a selected COUNT of nonnull samples and COUNT_DISTINCT compute over their
source population; the selected native and query-local SUM/COUNT ratios agree.
The unequal-bucket average is 19 rather than mean-of-groups 55, and overlapping
distinct sets have union count 3 rather than summed counts 4. The large case
aggregates all 60,001 source rows before the final scalar result; it does not
require those raw rows to be transported. Null samples, source clipping, empty
detail/source and regional totals preserve their declared wire types and nulls.
No sufficient-state or disjoint-domain recipe is inferred for retained scalars.

`ModelRevisionEndpoint.test.ts` reuses the canonical retained AVG SQL and its
independent raw-source oracle. The original definition returns 19; changing the
source projection to `amount + 1` changes the HAVING-retained population and
returns 11. An unchanged-version control keeps the old 19 and reads no new model.
Bumping the schema version recompiles the same authored SQL to 11, and another
revision restoring the original definition returns 19. Repeated requests retain
the matching compiler version, source SQL and Double wire type. The async
version callback exercises CompilerApi's production callback contract; it is a
fixture callback, not the QueryRails API's schema-version service. Source reads
are fresh because this fixture omits the orchestrator result cache. These checks
therefore establish native compiler/metadata/plan invalidation only.

`NeonBlendEndpoint.test.ts` is a controlled actual-source comparison. Run it by
path after generating the QueryRails candidate packet and setting
`QUERYRAILS_NEON_BLEND_PACKET_PATH` plus the existing `DATABASES_DIRECT_URL`.
The connection must have read access to the existing `tpc_h` database. The test
also requires `QUERYRAILS_APPLICATION_ROOT` for its QueryRails companion. It
selects customer IDs 1–25, checks read-only session configuration, and keeps a
30-second source statement bound. It runs independent natural-identity reference
SQL and the production compiler's candidate, comparing complete string values
and Int64 types. The shared fixture forbids setup SQL for an external source,
owns the production PostgreSQL cursor/driver release, and retains ordinary
DuckDB behavior. Missing inputs fail setup; an unavailable source is not a
numerical pass. Fixture grants and one source connection do not establish
application policies, distinct Fleet bindings, shared snapshots or dual-lane
qualification. Source credentials are never included in its capture.
The companion runs the actual QueryRails parent executor and supplied-value
adapter against an owned dedicated Fleet fixture node. The production client
requests Arrow; the node loads the already installed `nanoarrow` extension.
One parent run retains input/residual planning context and finalizes once, while
session admission and compute cleanup are exercised over the signed HTTP wire.
Fixture current-authority and ledger ports remain explicit. The native owner
creates and deletes a temporary capture file, then records the successful
application result together with its actual PostgreSQL source request.

The fourth case runs the same compiled question below Cube through the built
production Fleet driver, shared token minter and Arrow wire. An IPC-owned
QueryRails fixture child resolves three distinct logical source bindings into
read-only PostgreSQL catalogs `s0`, `s1` and `s2`; credentials stay in that child.
The candidate model changes only its physical table references. The external
fixture driver uses the DuckDB dialect and the existing QueryStream alias owner.
The child records attachment/query timings and cleanup, and the parent observes
only PostgreSQL connections carrying the child's unique application name.
Owned listeners, child, monitor driver and sessions are released on failure.

The installed-runtime federation numerical target fails at the unchanged 30-second
deadline. Its tagged source activity shows an unfiltered line-item key COPY;
the native plan estimates roughly six million line items. Attachment creation
and complete cleanup succeed. The same source SELECT also times out through
the ordinary Fleet engine without Arrow encoding. A private dynamic-filter
threshold experiment does not resolve it. Keep this as a failing numerical
target: timeout is neither an independent reference match nor a qualified
cannot-serve refusal. No serving gate, runtime qualification, source population
or production optimizer setting changes to accommodate it.

A controlled private runtime comparison now passes all four cases. It combines
PostgreSQL scan-local filter refresh, optional Bloom-hint handling and traversal
of input relations beneath in/out functions with a DuckDB equality-key hint
repair that skips NULL build keys. It uses a fixed 512-key optimizer probe; the
fully repaired variant still times out with the original 50-key threshold.
This is private evidence for the exact joined-count question, not public lane
qualification or an accepted general optimizer default.

`QUERYRAILS_NEON_FLEET_FIXTURE_BOOTSTRAP` can explicitly select a CommonJS
bootstrap for the IPC-owned Fleet child in this test. Other subprocesses retain
their ordinary runtime. The child captures only its loaded DuckDB library paths,
never a full process report or environment values. The controlled caller must
verify the pinned artifacts and record optimizer/trust settings with its run.

Passing these source fixtures does not qualify a deployed image or change runtime
admission. The maintained Cube/Arrow dependency pair still requires coordinated
release and application-level numerical, cache, authority and lifecycle capture.

### Grouped and calendar-date qualification (6 October 2026)

The same controlled Neon fixture now compiles TPCH-002 at customer/month grain,
with exact order and line amounts and a discriminating raw-join mutation. The
independent reference has 133 groups; the mutation differs in 116. Both the native
PostgreSQL-source and private Fleet federation executions still hit their unchanged
30-second deadline. These failures do not qualify numerical execution or fallback.
An ordinary PostgreSQL execution of the captured source SQL and its maintained
cursor implementation agree with the independent rows; their separate diagnostics
are not endpoint qualification. The former takes about 13 seconds and the latter
about 28 seconds in these bounded observations. Actual catalog key declarations
remove floating comparison casts but do not establish a performance improvement.

`AggregateKeyJoinEndpoint.test.ts` retains numerical checks for unmatched identities,
NULL groups, right-side predicates and right-side grouping. It also checks calendar
DATE and exact decimal headers through actual native HTTP. The original native DATE
schema serializes as an enum object, which the application cannot accept as a scalar
type name. The scoped schema repair emits `Date32` or `Date64` according to the
actual Arrow width; decimal headers continue to carry their exact precision/scale.
This is a native protocol repair in the existing coordinated release effort. It
neither ports the outer planner nor changes installed artifacts or public gates.

No legacy JavaScript key-query optimization is included: the observed statement is
owned by the native multiplied-measures planner. Any key-query pruning must preserve
original root population, right-side attributes and predicates, custom boundaries,
current policy, snapshots and complete identity sets, and needs measured evidence
at that actual owner. The 512-key optimizer probe does not solve the grouped case:
the line-item scan receives an IN hint while the order-price lookup remains
unfiltered. Broader connector, snapshot, resource and released-runtime qualification
and separate authorized above-Cube operands remain outstanding.

### Native identity-value optimization (6 October 2026)

The native physical builder now carries eligible root-owned sum values through
identity/group DISTINCT before aggregation, removing the second value lookup.
NULL or partially NULL composite identities retain ordinary equality lookup
semantics through a NULL value, while their group remains present. Equal values
on distinct identities contribute independently. Filtered, masked, contextual,
sub-query-dimension and other measure forms retain the existing lookup path.

The same identity branch can remove its unused Cube LEFT joins only when all
projected members and predicates belong to the root. It retains joins for
right-side predicates and grouping, opaque sub-query joins, protected join
filters and contextual stages. This does not change the authored query or the
population of the separate line-amount branch. The native source owner performs
this optimization; no legacy JavaScript key-query rewrite is included.

Ten local native HTTP cases pass, including exact decimals beyond JavaScript's
safe-integer range, calendar/NULL headers, matched/unmatched and empty populations,
right-side attribution, filtered-measure lookup retention and composite NULL keys.
The earlier DATE-repaired addon preserves all numerical cases and fails the
three lookup-elimination assertions, providing a control. The new private addon
returns the complete 133-group TPCH-002 reference through native PostgreSQL and
Fleet federation with exact type, NULL and order contracts. Observed times are
about 15.47 and 18.80 seconds with the unchanged 30-second deadline. The private
federation comparison still uses the controlled 512-key probe, repaired scanner
and repaired DuckDB core. These bounded timings are not a general performance
budget or production optimizer-default approval.

The original count fixture still passes all four endpoint/wire cases. The
application's grouped decimal admission remains a typed refusal before dispatch;
no public qualification gate is changed. Separately authorized above-Cube operands,
real application authority, snapshot/resource breadth and released runtimes remain
outstanding in the existing coordinated release effort.

The verified original 50-key optimizer default still times out on the grouped
question after this native repair, with zero rows and complete cleanup. The
private 512 comparison therefore remains necessary for the passing observation;
neither the native optimization nor the control justifies changing a production
default or enabling public auto.

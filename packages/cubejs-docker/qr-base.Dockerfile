# QueryRails custom cube base image.
#
# Builds the QueryRails cube fork's customizations and overlays the compiled native and JS
# artifacts onto the official cube image, so a single image carries:
#   - qualified CubeSQL filter bindings that preserve dotted output aliases
#   - governed joined-input policy placement and preserved policy origins
#   - regular/wrapped null placement, ordinal ordering and native cancellation
#   - exact decimal decoding and incomplete row-cap result rejection
#   - DuckDB NULL results for undefined finite correlations and spatial loading
#   - the SQL function-template dead-key fix + per-dialect overrides
#     (schema-compiler + druid/firebolt/pinot/ksql query dialects)
#   - number_agg measures without multi_stage (schema-compiler CubeValidator)
#   - the DuckLake initSql fail-fast in the duckdb-driver: INSTALL the lake
#     extensions before initSql, and THROW on initSql/ATTACH failure instead of
#     logging "skipping" and serving a lake-less engine
#
# Fork tracks upstream v1.7.42. QueryRails keeps only the custom behaviour that
# remains absent upstream, and qualifies the complete rebased image by digest.
# Rust/native and the QueryRails Arrow DataFusion dependency are carried source
# deltas. Building this image does not replace numerical endpoint qualification;
# historical captures retain the digest on which they actually ran.
#
# The official image downloads upstream's native addon. Compile the fork's
# native addon here so Rust CubeSQL fixes are included alongside the JS changes.
# Build context = the fork repo root; .dockerignore includes both Rust workspaces
# and excludes local native artifacts and Cargo build caches.
#
# Pin both image contents and versions. Rebase source and refresh these
# verified registry digests together when changing the upstream Cube version.
ARG CUBE_VERSION=v1.7.42

# ── Stage 1: build native and changed JS packages from fork source ─────────────────────
FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS builder
ARG CUBE_VERSION

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       curl ca-certificates python3 python3.13 libpython3.13-dev gcc g++ make cmake openjdk-21-jdk-headless \
    && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH \
    PYO3_PYTHON=python3.13 \
    CARGO_BUILD_JOBS=2
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- --profile minimal --default-toolchain none -y

WORKDIR /cubejs
COPY . .

# Rebase source before changing the upstream image version. Otherwise the
# overlay would retain a different runtime's package manifests/dependencies.
RUN node -e "const version = process.env.CUBE_VERSION; const fork = require('./lerna.json').version; if (version !== 'v' + fork) throw new Error('CUBE_VERSION must match fork version v' + fork); for (const dir of ['cubejs-backend-native', 'cubejs-api-gateway', 'cubejs-server-core', 'cubejs-query-orchestrator', 'cubejs-postgres-driver', 'cubejs-base-driver', 'cubejs-schema-compiler', 'cubejs-duckdb-driver', 'cubejs-druid-driver', 'cubejs-firebolt-driver', 'cubejs-pinot-driver', 'cubejs-ksql-driver']) { if (require('./packages/' + dir + '/package.json').version !== fork) throw new Error('Fork package version mismatch: ' + dir); }"

RUN yarn policies set-version v1.22.22 \
    && yarn config set network-timeout 120000 -g

# Dev install (build deps), then build the changed JS packages and their
# build-time dependencies.
# A lockfile mismatch must stop the image build rather than resolve a different
# dependency graph from the one reviewed with the source repairs.
RUN yarn install --frozen-lockfile
# Playground is a server-core build dependency. Client package build tasks
# emit declarations; the root build also produces the runtime bundles that
# Playground imports. Follow the upstream build order on a clean checkout.
RUN yarn build
RUN yarn lerna run build \
      --scope @cubejs-backend/native \
      --scope @cubejs-backend/api-gateway \
      --scope @cubejs-backend/server-core \
      --scope @cubejs-backend/query-orchestrator \
      --scope @cubejs-backend/postgres-driver \
      --scope @cubejs-backend/base-driver \
      --scope @cubejs-backend/schema-compiler \
      --scope @cubejs-backend/duckdb-driver \
      --scope @cubejs-backend/druid-driver \
      --scope @cubejs-backend/firebolt-driver \
      --scope @cubejs-backend/pinot-driver \
      --scope @cubejs-backend/ksql-driver \
      --include-dependencies --concurrency 2

# Preserve Python support from the official runtime. Cargo uses the fork's
# pinned toolchain and lockfile; copy only the resulting Linux native addon.
RUN cd packages/cubejs-backend-native \
    && npm run native:build-release-python -- --locked

# ── Stage 2: overlay the fork-built artifacts onto the official cube image ───────
FROM cubejs/cube:${CUBE_VERSION}-jdk@sha256:718df8f9a55dbcbe0778bad66ccce094e915947a987e9f9760635dee76d5da2b

USER root

ARG CUBE_VERSION
ARG CUBE_SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/simonedbarber/cube" \
      org.opencontainers.image.revision="${CUBE_SOURCE_REVISION}"

COPY --from=builder --chown=cube:cube \
     /cubejs/packages/cubejs-backend-native/index.node \
     /cube/node_modules/@cubejs-backend/native/native/index.node

# Overlay every repaired runtime boundary together. The upstream JS wrappers,
# gateway, compiler policy owner, cache and source driver cannot accompany only
# the repaired addon: they carry null placement, policy-origin and cancellation
# contracts consumed by that native build.
COPY --from=builder --chown=cube:cube \
     /cubejs/packages/cubejs-backend-native/dist/js \
     /cube/node_modules/@cubejs-backend/native/dist/js
COPY --from=builder --chown=cube:cube \
     /cubejs/packages/cubejs-api-gateway/dist \
     /cube/node_modules/@cubejs-backend/api-gateway/dist
COPY --from=builder --chown=cube:cube \
     /cubejs/packages/cubejs-server-core/dist \
     /cube/node_modules/@cubejs-backend/server-core/dist
COPY --from=builder --chown=cube:cube \
     /cubejs/packages/cubejs-query-orchestrator/dist \
     /cube/node_modules/@cubejs-backend/query-orchestrator/dist
COPY --from=builder --chown=cube:cube \
     /cubejs/packages/cubejs-postgres-driver/dist \
     /cube/node_modules/@cubejs-backend/postgres-driver/dist
COPY --from=builder --chown=cube:cube \
     /cubejs/packages/cubejs-base-driver/dist \
     /cube/node_modules/@cubejs-backend/base-driver/dist

# Existing function-template, number_agg, dialect and initialization repairs.
COPY --from=builder --chown=cube:cube \
     /cubejs/packages/cubejs-schema-compiler/dist \
     /cube/node_modules/@cubejs-backend/schema-compiler/dist
COPY --from=builder --chown=cube:cube \
     /cubejs/packages/cubejs-duckdb-driver/dist \
     /cube/node_modules/@cubejs-backend/duckdb-driver/dist
COPY --from=builder --chown=cube:cube \
     /cubejs/packages/cubejs-druid-driver/dist \
     /cube/node_modules/@cubejs-backend/druid-driver/dist
COPY --from=builder --chown=cube:cube \
     /cubejs/packages/cubejs-firebolt-driver/dist \
     /cube/node_modules/@cubejs-backend/firebolt-driver/dist
COPY --from=builder --chown=cube:cube \
     /cubejs/packages/cubejs-pinot-driver/dist \
     /cube/node_modules/@cubejs-backend/pinot-driver/dist
COPY --from=builder --chown=cube:cube \
     /cubejs/packages/cubejs-ksql-driver/dist \
     /cube/node_modules/@cubejs-backend/ksql-driver/dist

# Load both the built addon and the overlaid runtime entry points against the
# final image's Node/Python ABI and dependency graph before publishing.
RUN node -e "require('/cube/node_modules/@cubejs-backend/native/native/index.node'); for (const name of ['native', 'api-gateway', 'server-core', 'query-orchestrator', 'postgres-driver', 'base-driver', 'schema-compiler', 'duckdb-driver', 'druid-driver', 'firebolt-driver', 'pinot-driver', 'ksql-driver']) { const root = '/cube/node_modules/@cubejs-backend/' + name; if ('v' + require(root + '/package.json').version !== process.env.CUBE_VERSION) throw new Error('Final runtime package version mismatch: ' + name); require(root); }"

USER cube

CMD ["cubejs", "server"]

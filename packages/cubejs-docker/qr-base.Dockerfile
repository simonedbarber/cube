# QueryRails custom cube base image.
#
# Builds the QueryRails cube fork's customizations and overlays the compiled native and JS
# artifacts onto the official cube image, so a single image carries:
#   - qualified CubeSQL filter bindings that preserve dotted output aliases
#   - the SQL function-template dead-key fix + per-dialect overrides
#     (schema-compiler + druid/firebolt/pinot/ksql query dialects)
#   - number_agg measures without multi_stage (schema-compiler CubeValidator)
#   - the DuckLake initSql fail-fast in the duckdb-driver: INSTALL the lake
#     extensions before initSql, and THROW on initSql/ATTACH failure instead of
#     logging "skipping" and serving a lake-less engine
#
# Fork tracks upstream v1.7.42. QueryRails keeps only the custom behaviour that
# remains absent upstream, and qualifies the complete rebased image by digest.
#
# The official image downloads upstream's native addon. Compile the fork's
# native addon here so Rust CubeSQL fixes are included alongside the JS changes.
# Build context = the fork repo root; .dockerignore includes both Rust workspaces
# and excludes local native artifacts and Cargo build caches.
#
# Pin the FROM tag to the cube version this fork is based on.
ARG CUBE_VERSION=v1.7.42

# ── Stage 1: build native and changed JS packages from fork source ─────────────────────
FROM node:24.21.0-trixie-slim AS builder

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

RUN yarn policies set-version v1.22.22 \
    && yarn config set network-timeout 120000 -g

# Dev install (build deps), then build the changed JS packages and their
# build-time dependencies.
RUN yarn install --frozen-lockfile || yarn install
RUN yarn lerna run build \
      --scope @cubejs-backend/schema-compiler \
      --scope @cubejs-backend/duckdb-driver \
      --scope @cubejs-backend/druid-driver \
      --scope @cubejs-backend/firebolt-driver \
      --scope @cubejs-backend/pinot-driver \
      --scope @cubejs-backend/ksql-driver \
      --include-dependencies

# Preserve Python support from the official runtime. Cargo uses the fork's
# pinned toolchain and lockfile; copy only the resulting Linux native addon.
RUN cd packages/cubejs-backend-native \
    && npm run native:build-release-python -- --locked

# ── Stage 2: overlay the fork-built artifacts onto the official cube image ───────
FROM cubejs/cube:${CUBE_VERSION}-jdk

USER root

ARG CUBE_SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/simonedbarber/cube" \
      org.opencontainers.image.revision="${CUBE_SOURCE_REVISION}"

COPY --from=builder --chown=cube:cube \
     /cubejs/packages/cubejs-backend-native/index.node \
     /cube/node_modules/@cubejs-backend/native/native/index.node

# The fork-built JS dist of the changed packages (function-template fix,
# number_agg, per-dialect overrides, duckdb initSql fail-fast).
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

# Verify that the built addon loads against the final image's Node/Python ABI.
RUN node -e "require('/cube/node_modules/@cubejs-backend/native/native/index.node')"

USER cube

CMD ["cubejs", "server"]

# QueryRails custom cube base image.
#
# Builds the QueryRails cube fork's customizations and overlays the compiled JS
# artifacts onto the official cube image, so a single image carries:
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
# Dropped at the v1.7.42 rebase (now upstream, no fork delta left to compile):
#   - the 2-arg aggregate SQL push-down (upstream generalised it to variadic
#     aggregates: agg_fun_expr_var_arg), so the native addon is now identical to
#     the official image's and is NO LONGER built from Rust source here
#   - the @duckdb/node-api (neo) port of the duckdb driver (upstream #11910),
#     including the manual `npm install @duckdb/node-api` — the official image
#     now ships it as a real driver dependency at the pinned version
#
# Build context = the fork repo root (the repo's default .dockerignore suffices;
# no Rust source is needed).
#
# Pin the FROM tag to the cube version this fork is based on.
ARG CUBE_VERSION=v1.7.42

# ── Stage 1: build the changed JS packages from fork source ─────────────────────
FROM node:24.21.0-trixie-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       curl ca-certificates python3 python3.13 libpython3.13-dev gcc g++ make cmake openjdk-21-jdk-headless \
    && rm -rf /var/lib/apt/lists/*

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

# ── Stage 2: overlay the fork-built artifacts onto the official cube image ───────
FROM cubejs/cube:${CUBE_VERSION}-jdk

USER root

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

USER cube

CMD ["cubejs", "server"]

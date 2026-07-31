# QueryRails custom cube base image.
#
# Builds the QueryRails cube fork's customizations FROM SOURCE and overlays the
# compiled artifacts onto the official cube image, so a single image carries:
#   - the 2-arg aggregate SQL push-down fix (Rust → native addon; cubesql)
#   - the SQL function-template dead-key fix + per-dialect overrides (schema-compiler)
#   - number_agg-without-multi_stage (schema-compiler)
#   - the DuckLake/neo duckdb-driver: @duckdb/node-api execution + a custom
#     DuckDBValueConverter that renders TIME/TIME_TZ/INTERVAL to display strings
#     (duckdb-driver)
#
# Fork tracks upstream v1.7.16. The tesseract dimension-only-expr dedup and the
# number_agg validator were fixed upstream and are no longer carried as patches.
#
# The official `latest-debian-jdk` image DOWNLOADS a prebuilt native addon via the
# post-installer, so it would ship the STOCK native (no 2-arg push-down fix). This
# Dockerfile compiles the native addon from the fork source and overlays it, plus the
# fork-built JS dist of the changed packages, onto the official image. Build context =
# the fork repo root.
#
# Pin the FROM tag to the cube version this fork is based on.
ARG CUBE_VERSION=v1.7.16

# ── Stage 1: build the native addon + changed JS dist from fork source ──────────
FROM node:24.18.0-trixie-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       curl ca-certificates python3 python3.13 libpython3.13-dev gcc g++ make cmake openjdk-21-jdk-headless \
    && rm -rf /var/lib/apt/lists/*

# Rust toolchain — the channel is pinned by rust/cubesql/rust-toolchain.toml (1.90.0),
# which rustup auto-installs on first cargo invocation.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- --profile minimal -y

WORKDIR /cubejs
COPY . .

RUN yarn policies set-version v1.22.22 \
    && yarn config set network-timeout 120000 -g

# Dev install (build deps), then build the changed JS packages (+ their build-time
# deps) and the native addon from source. The native build is the heavy step (cubesql
# + cubesqlplanner + cubeorchestrator + cubenativeutils, release).
RUN yarn install --frozen-lockfile || yarn install
RUN yarn lerna run build \
      --scope @cubejs-backend/schema-compiler \
      --scope @cubejs-backend/duckdb-driver \
      --scope @cubejs-backend/druid-driver \
      --scope @cubejs-backend/firebolt-driver \
      --scope @cubejs-backend/pinot-driver \
      --scope @cubejs-backend/ksql-driver \
      --include-dependencies
RUN cd packages/cubejs-backend-native \
    && npm run native:build-release \
    && cp index.node native/index.node

# ── Stage 2: overlay the fork-built artifacts onto the official cube image ───────
FROM cubejs/cube:${CUBE_VERSION}-jdk

USER root

# (1) The source-built native addon (2-arg aggregate + tesseract-dedup fixes).
COPY --from=builder --chown=cube:cube \
     /cubejs/packages/cubejs-backend-native/native/index.node \
     /cube/node_modules/@cubejs-backend/native/native/index.node

# (2) The fork-built JS dist of the changed packages (function-template fix,
#     number_agg, per-dialect overrides, DuckLake/neo duckdb path).
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

# (3) The DuckLake/neo runtime dependency the patched duckdb-driver requires
#     (the official image only ships classic `duckdb`).
RUN cd /cube && npm install --no-save @duckdb/node-api@1.5.5-r.3

USER cube

CMD ["cubejs", "server"]

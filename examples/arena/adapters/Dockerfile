# syntax=docker/dockerfile:1
FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/runtime
COPY runtime/package.json runtime/package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY opencode /usr/local/bin/opencode
RUN chmod 755 /usr/local/bin/opencode
COPY --chmod=755 pinata/ /opt/pinata/
RUN ln -s /opt/runtime/node_modules /opt/pinata/node_modules && \
    ln -s /opt/runtime/node_modules /opt/runtime/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/node_modules
COPY --chmod=755 adapters/ /opt/arena-adapters/
ENV ARENA_RUNTIME_ROOT=/opt/runtime/package.json
ENV PATH="/opt/runtime/node_modules/.bin:/usr/local/bin:/usr/bin:/bin" \
    PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
    XDG_CACHE_HOME=/runtime/cache XDG_DATA_HOME=/runtime/data XDG_CONFIG_HOME=/tmp/config
WORKDIR /work
CMD ["node", "/opt/arena-adapters/run.mjs"]

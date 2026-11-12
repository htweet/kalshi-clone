# syntax=docker/dockerfile:1.7
# Parlance Exchange production image (PLAN P9.1, CLONE_SPEC.md §39.2).
#   - multi-stage: dependencies and the asset build in `build`; the runtime stage has production dependencies only
#     (no esbuild, eslint, playwright, no compilers), the hashed bundle in dist/ and the server;
#   - the Node 22 base is pinned by digest (Dependabot bumps it); the process runs as the unprivileged `node` user;
#   - the root file system can be read-only (deploy/docker-compose.yml sets read_only: true): the only writable place is
#     the /data volume (database, its WAL, the local object and backup folders when no bucket is configured) and /tmp;
#   - no data/, keys or .env files can enter the image (.dockerignore), and the build fails if any did;
#   - HEALTHCHECK calls /healthz on the loopback listener.
# Build: docker build -t parlance:local .      Run: see deploy/docker-compose.yml and the README "Deployment" section.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

FROM ${NODE_IMAGE} AS build
WORKDIR /src/clone
ENV SKIP_GIT_HOOKS=1 NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false
COPY clone/package.json clone/package-lock.json ./
# An optional build secret `ca` (a CA bundle) is trusted for this one step only: local CI behind an intercepting proxy
# (scripts/ci-local.sh) passes it; CI and production builds do not, and nothing of it stays in any layer.
RUN --mount=type=secret,id=ca,required=false sh -c 'if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; npm ci --ignore-scripts'
COPY clone/ ./
# Guard: secrets and data never reach the image, whatever the build context held.
RUN if find . -path ./node_modules -prune -o \( -name '.env' -o -name '.env.*' ! -name '.env.example' -o -name '*.key' -o -name '*.pem' -o -name '*.db' -o -name '*.db-wal' -o -name 'secret.keyring.json' \) -print | grep -q .; then echo 'refusing to build: secrets or data files in the build context' >&2; exit 1; fi \
  && rm -rf data tests test-results playwright-report
RUN node scripts/build.js && npm prune --omit=dev --ignore-scripts

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="Parlance Exchange" org.opencontainers.image.source="https://github.com/htweet/kalshi-clone"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DB_FILE=/data/parlance.db ASSETS=dist METRICS_PORT=9464 METRICS_HOST=0.0.0.0 \
    OBJECT_STORAGE=local:/data/objects BACKUP_STORAGE=local:/data/backups NODE_OPTIONS=--no-warnings
WORKDIR /app
COPY --from=build /src/clone/package.json /src/clone/package-lock.json ./
COPY --from=build /src/clone/node_modules ./node_modules
COPY --from=build /src/clone/server ./server
COPY --from=build /src/clone/public ./public
COPY --from=build /src/clone/dist ./dist
COPY --from=build /src/clone/scripts/build.js /src/clone/scripts/restore.js /src/clone/scripts/keys.js /src/clone/scripts/backup-verify.js ./scripts/
# npm, npx, corepack and yarn are not needed at run time (and carry their own advisories): removed from the runtime image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && mkdir -p /data && chown node:node /data && chmod 0700 /data
USER node
VOLUME ["/data"]
EXPOSE 3000 9464 9878
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server/index.js"]

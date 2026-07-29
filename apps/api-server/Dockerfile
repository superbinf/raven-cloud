FROM node:22-alpine AS build
ARG TARGETARCH
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/admin-web/package.json apps/admin-web/package.json
COPY apps/api-server/package.json apps/api-server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/distribution/package.json packages/distribution/package.json
COPY packages/file-preview/package.json packages/file-preview/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/transport-security/package.json packages/transport-security/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN npm ci

COPY apps/admin-web apps/admin-web
COPY apps/api-server apps/api-server
COPY packages packages
RUN npm run build -w @sentinel/admin-web \
    && npm prune --omit=dev \
    && case "$TARGETARCH" in amd64) sharp_cpu=x64 ;; arm64) sharp_cpu=arm64 ;; *) echo "Unsupported target architecture: $TARGETARCH" >&2; exit 2 ;; esac \
    && npm install --no-save --include=optional --os=linux --libc=musl --cpu="$sharp_cpu" sharp@0.35.3

FROM node:22-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    SENTINEL_ADMIN_DIST=/app/apps/admin-web/dist \
    SENTINEL_DATA_DIR=/var/lib/sentinel-cloud/data
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api-server ./apps/api-server
COPY --from=build --chown=node:node /app/apps/admin-web/dist ./apps/admin-web/dist
COPY --from=build --chown=node:node /app/packages ./packages
RUN rm -rf /app/apps/api-server/test /app/packages/*/test \
    && chmod 0755 /app/apps/api-server/scripts/docker-entrypoint.sh \
    && mkdir -p /var/lib/sentinel-cloud/data \
    && chown -R node:node /var/lib/sentinel-cloud

ENTRYPOINT ["/app/apps/api-server/scripts/docker-entrypoint.sh"]
EXPOSE 8787
CMD ["node", "apps/api-server/src/server.mjs"]

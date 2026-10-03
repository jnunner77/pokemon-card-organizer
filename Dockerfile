# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4100 \
    DATA_DIR=/data \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY server ./server
COPY scripts ./scripts
COPY public ./public
# The data directory is owned by the unprivileged user so a fresh volume inherits it.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4100) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "--import", "tsx", "server/index.ts"]

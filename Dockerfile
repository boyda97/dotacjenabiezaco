# Dotacjo: jeden kontener z backendem (Node 22), stroną i silnikiem (Python).
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/konta-platnosci
COPY konta-platnosci/package.json konta-platnosci/package-lock.json ./
RUN npm ci --omit=dev

COPY konta-platnosci/ ./
COPY strona/index.html ./public/index.html
COPY silnik/ /app/silnik/
COPY deploy/start.sh /app/start.sh
COPY deploy/stripe-webhook.mjs ./scripts/stripe-webhook.mjs
RUN mkdir -p /data /kopie && chown node:node /data /kopie

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/dotacjo.db \
    DOTACJOMAT_DB=/data/silnik.db \
    SILNIK_DIR=/app/silnik \
    SILNIK_PYTHON=python3

VOLUME /data
EXPOSE 3000
USER node
ENTRYPOINT ["tini", "--"]
CMD ["/app/start.sh"]

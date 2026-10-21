# VoteChain backend API (docker-compose.yml `backend` service).
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .
# local IPFS store (volume) — created here so the volume inherits the node user's ownership
RUN mkdir -p /app/data/ipfs && chown -R node:node /app

USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=6 \
  CMD wget -qO- http://127.0.0.1:4000/api/health >/dev/null || exit 1
CMD ["node", "src/server.js"]

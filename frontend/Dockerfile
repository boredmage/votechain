# VoteChain frontend (docker-compose.yml `frontend` service): Vite production build served by nginx,
# which also proxies /api to the backend so the browser only ever talks to one origin.
FROM node:22-alpine AS build

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
# Vite inlines VITE_* at build time (see src/lib/env.js). An empty VITE_API_URL means same-origin
# /api, which nginx.conf forwards to the backend. The RPC URL is what the *browser* dials, so it
# stays on localhost: the chain's port 8545 is published by docker-compose.yml.
ARG VITE_API_URL=""
ARG VITE_RPC_URL=http://127.0.0.1:8545
ARG VITE_CHAIN_ID=31337
ARG VITE_NETWORK=localhost
ARG VITE_DEMO_MODE=true
ENV VITE_API_URL=$VITE_API_URL \
    VITE_RPC_URL=$VITE_RPC_URL \
    VITE_CHAIN_ID=$VITE_CHAIN_ID \
    VITE_NETWORK=$VITE_NETWORK \
    VITE_DEMO_MODE=$VITE_DEMO_MODE
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

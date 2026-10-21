# Deploy-and-seed job for docker-compose.yml. Compiles the contracts at build time; at run time
# hardhat/bootstrap.js waits for the chain, deploys the five modules and seeds the demo election
# (skipped when the deployment already exists on the chain). Debian rather than Alpine: Hardhat's
# native solc build needs glibc.
FROM node:22-bookworm-slim

WORKDIR /app
ENV HARDHAT_DISABLE_TELEMETRY_PROMPT=true \
    NODE_OPTIONS=--no-deprecation

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npx hardhat compile \
    && mkdir -p deployments \
    && chown -R node:node /app

USER node
ENTRYPOINT ["node", "hardhat/bootstrap.js"]

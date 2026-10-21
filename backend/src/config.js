import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
export const backendRoot = resolve(here, "..");
export const repoRoot = resolve(backendRoot, "..");

// .env at the repository root is shared by contracts, backend and frontend; backend/.env overrides.
dotenv.config({ path: join(repoRoot, ".env") });
dotenv.config({ path: join(backendRoot, ".env"), override: true });

const env = (key, fallback) => (process.env[key] !== undefined && process.env[key] !== "" ? process.env[key] : fallback);

const networkName = env("NETWORK", "localhost");
const deploymentPath = env("DEPLOYMENT_FILE", join(repoRoot, "contracts", "deployments", `${networkName}.json`));

export const config = {
  port: Number(env("PORT", 4000)),
  corsOrigin: env("CORS_ORIGIN", "*"),
  rpcUrl: env("RPC_URL", "http://127.0.0.1:8545"),
  network: networkName,
  deploymentPath,
  abiDir: env("ABI_DIR", join(backendRoot, "abi")),
  databaseUrl: env("DATABASE_URL", ""),
  indexerPollMs: Number(env("INDEXER_POLL_MS", 3000)),
  indexerBatchBlocks: Number(env("INDEXER_BATCH_BLOCKS", 2000)),
  sessionTtlSeconds: Number(env("SESSION_TTL_SECONDS", 12 * 3600)),
  demoMode: env("DEMO_MODE", "true") === "true",
  demoAccountsPath: env("DEMO_ACCOUNTS_FILE", join(repoRoot, "contracts", "deployments", "demo-accounts.json")),
  ipfs: {
    provider: env("IPFS_PROVIDER", "local"), // local | kubo | pinata
    localDir: env("IPFS_LOCAL_DIR", join(backendRoot, "data", "ipfs")),
    kuboApiUrl: env("KUBO_API_URL", "http://127.0.0.1:5001"),
    kuboGatewayUrl: env("KUBO_GATEWAY_URL", "http://127.0.0.1:8080"),
    pinataJwt: env("PINATA_JWT", ""),
    pinataGatewayUrl: env("PINATA_GATEWAY_URL", "https://gateway.pinata.cloud"),
    maxUploadBytes: Number(env("MAX_UPLOAD_BYTES", 15 * 1024 * 1024)),
  },
};

export function loadDeployment() {
  if (!existsSync(config.deploymentPath)) {
    throw new Error(
      `Deployment file not found at ${config.deploymentPath}. Deploy the contracts first (see README) or set DEPLOYMENT_FILE.`,
    );
  }
  return JSON.parse(readFileSync(config.deploymentPath, "utf8"));
}

export function loadDemoAccounts() {
  if (!config.demoMode || !existsSync(config.demoAccountsPath)) return null;
  return JSON.parse(readFileSync(config.demoAccountsPath, "utf8"));
}

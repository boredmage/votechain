/**
 * Entrypoint of the `deployer` service in docker-compose.yml: waits for the local chain, then
 * deploys the five contracts and seeds the demo election. A deployment that is already on the chain
 * (deployments/localhost.json points at live code and demo-accounts.json exists) is left alone, so
 * `docker compose up` is idempotent; `docker compose down -v` wipes everything for a fresh seed.
 *
 *   LOCAL_RPC_URL   chain RPC URL                             (default http://127.0.0.1:8545)
 *   DEMO_PREFILL    none | lga | all | declared               (default lga, see seed-demo.js)
 */
const { execSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

const RPC_URL = process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545";
const PREFILL = (process.env.DEMO_PREFILL || "lga").toLowerCase();
const WAIT_MS = Number(process.env.CHAIN_WAIT_MS || 120000);

const root = path.join(__dirname, "..");
const deploymentFile = path.join(root, "deployments", "localhost.json");
const demoAccountsFile = path.join(root, "deployments", "demo-accounts.json");

const step = (msg) => console.log(`\n▸ ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

async function waitForChain() {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      const chainId = parseInt(await rpc("eth_chainId"), 16);
      console.log(`  chain ${chainId} reachable at ${RPC_URL}`);
      return chainId;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`no chain at ${RPC_URL} after ${WAIT_MS / 1000}s (${err.message})`);
      await sleep(1000);
    }
  }
}

async function alreadyDeployed(chainId) {
  if (!existsSync(deploymentFile) || !existsSync(demoAccountsFile)) return false;
  const d = JSON.parse(readFileSync(deploymentFile, "utf8"));
  if (d.chainId !== chainId) return false;
  const code = await rpc("eth_getCode", [d.contracts.ElectionManager, "latest"]);
  return typeof code === "string" && code !== "0x";
}

async function main() {
  step(`Waiting for the chain at ${RPC_URL}`);
  const chainId = await waitForChain();

  if (await alreadyDeployed(chainId)) {
    step("Contracts already deployed and seeded — nothing to do");
    console.log("  (run `docker compose down -v` first for a fresh election)");
    return;
  }

  step("Deploying the contracts");
  execSync("npx hardhat run hardhat/deploy.js --network localhost", { cwd: root, stdio: "inherit" });

  step(`Seeding the demo election (prefill: ${PREFILL})`);
  execSync("npx hardhat run hardhat/seed-demo.js --network localhost", {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, DEMO_PREFILL: PREFILL },
  });

  console.log(`\n✓ Deployed and seeded (prefill: ${PREFILL})`);
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});

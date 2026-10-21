#!/usr/bin/env node
/**
 * One-command development reset: fresh chain state, empty PostgreSQL cache, redeployed contracts,
 * a seeded demo election at the chosen prefill level, and a backend restart.
 *
 *   npm run reset                 # prefill "lga"  — LGA 2 pre-collated, LGA 1 left for you (default)
 *   npm run reset -- none         # configured + activated, nothing uploaded
 *   npm run reset -- all          # every unit approved up to the state; the auditor and publisher are next
 *   npm run reset -- declared     # the finished election: audited and declared
 *
 * Needs the local chain (anvil or `npx hardhat node`) already running on RPC_URL. The chain is wiped
 * in place with anvil_reset / hardhat_reset, so you do not have to restart it.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, utimesSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEVELS = ["none", "lga", "all", "declared"];
const level = (process.argv[2] ?? "lga").toLowerCase();
if (!LEVELS.includes(level)) {
  console.error(`Unknown prefill level "${level}". Use one of: ${LEVELS.join(", ")}`);
  process.exit(1);
}

// minimal .env reader (the repo-root .env shared by contracts, backend and frontend)
const env = { ...process.env };
const envFile = join(root, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const RPC_URL = env.RPC_URL || "http://127.0.0.1:8545";
const step = (msg) => console.log(`\n▸ ${msg}`);
const run = (cmd, cwd, extraEnv = {}) => execSync(cmd, { cwd, stdio: "inherit", env: { ...process.env, ...extraEnv } });

async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

// 1. chain ------------------------------------------------------------------------------
step(`Resetting the chain at ${RPC_URL}`);
try {
  await rpc("eth_chainId");
} catch {
  console.error(`No chain at ${RPC_URL}. Start one first:  anvil --accounts 70   (or: npm run chain)`);
  process.exit(1);
}
let reset = false;
for (const method of ["anvil_reset", "hardhat_reset"]) {
  try {
    await rpc(method, []);
    console.log(`  ${method} ✓ (block ${parseInt(await rpc("eth_blockNumber"), 16)})`);
    reset = true;
    break;
  } catch {
    /* not this client — try the other one */
  }
}
if (!reset) {
  console.error("  The node supports neither anvil_reset nor hardhat_reset. Restart it manually, then run this again.");
  process.exit(1);
}

// 2. database -----------------------------------------------------------------------------
if (env.DATABASE_URL) {
  step("Clearing the PostgreSQL cache");
  const require = createRequire(join(root, "backend", "package.json"));
  const { Client } = require("pg");
  const db = new Client({ connectionString: env.DATABASE_URL });
  try {
    await db.connect();
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    console.log("  schema dropped ✓");
  } catch (err) {
    console.error(`  Could not reach PostgreSQL (${err.message}). Is it running?  docker compose up -d postgres`);
    process.exit(1);
  } finally {
    await db.end().catch(() => {});
  }
  run("npm run --silent migrate", join(root, "backend"));
} else {
  step("DATABASE_URL is empty — chain-only mode, no cache to clear");
}

// 3. contracts + seed -------------------------------------------------------------------------
step("Deploying the contracts");
run("npm run --silent deploy:local", join(root, "contracts"));
step(`Seeding the demo election (prefill: ${level})`);
run("npx hardhat run hardhat/seed-demo.js --network localhost", join(root, "contracts"), { DEMO_PREFILL: level });

// 4. backend ----------------------------------------------------------------------------------
// The indexer keeps its block cursor in memory, so it must restart. `npm run backend` runs
// `node --watch`, which restarts when server.js changes — touching the file is enough.
step("Restarting the backend");
const server = join(root, "backend", "src", "server.js");
const now = new Date();
utimesSync(server, now, now);
console.log("  touched backend/src/server.js → `npm run backend` (node --watch) restarts by itself.");
console.log("  If you started the backend another way, restart it now.");

console.log(`\n✓ Reset complete (prefill: ${level}). Refresh http://localhost:5173`);
const next = {
  none: "Act as Presiding Officer #4 to upload the first EC8A.",
  lga: "LGA 2 is collated. Drive LGA 1 yourself: Presiding Officer #4 → party agents #18, #33, #48 → Ward officer #12 …",
  all: "Every level is approved. Act as the Independent Auditor (#2) to sign, then the Result Publisher (#3) to declare.",
  declared: "The election is declared. Open Public verification to explore the full audit trail.",
}[level];
console.log(`  Next: ${next}`);

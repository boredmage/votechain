#!/usr/bin/env node
/**
 * Exports the ABI of the five VoteChain contracts from the Foundry build output
 * (contracts/out) — or from the Hardhat artifacts if that is what was built — into
 * contracts/abi/<Name>.json, and copies them into backend/abi and frontend/src/abi.
 *
 *   node scripts/export-abis.mjs
 *
 * Dependency-free so it runs before `npm install`.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const names = ["ElectionManager", "ResultUpload", "PartyAgentVerification", "CollationEngine", "AuditDeclaration"];

function loadAbi(name) {
  const foundry = join(root, "contracts", "out", `${name}.sol`, `${name}.json`);
  const hardhat = join(root, "contracts", "artifacts", "src", `${name}.sol`, `${name}.json`);
  const path = existsSync(foundry) ? foundry : existsSync(hardhat) ? hardhat : null;
  if (!path) throw new Error(`No build artifact for ${name}. Run 'forge build' or 'npx hardhat compile' in contracts/ first.`);
  return JSON.parse(readFileSync(path, "utf8")).abi;
}

const targets = [
  join(root, "contracts", "abi"),
  join(root, "backend", "abi"),
  join(root, "frontend", "src", "abi"),
];
for (const dir of targets) mkdirSync(dir, { recursive: true });

const index = {};
for (const name of names) {
  const abi = loadAbi(name);
  index[name] = abi;
  for (const dir of targets) writeFileSync(join(dir, `${name}.json`), JSON.stringify(abi, null, 2));
  console.log(`exported ${name} (${abi.length} entries)`);
}
for (const dir of targets) writeFileSync(join(dir, "index.json"), JSON.stringify(index));
console.log(`wrote ABI bundles to:\n  ${targets.join("\n  ")}`);

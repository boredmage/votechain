#!/usr/bin/env node
/**
 * Scripted end-to-end walkthrough of every VoteChain portal (usability-study task script, Section 3.11.3).
 * Drives Chromium through the complete flow on the seeded local election: EC8A upload → dispute →
 * correction → re-signing → ward mismatch → collations → audit signature → declaration, saving a
 * screenshot per step to e2e/screenshots/.
 *
 *   # prerequisites: local node + deploy + `npm run seed:local:prefill` (contracts), backend and frontend running
 *   cd frontend && npm i -D playwright && npx playwright install chromium
 *   BASE_URL=http://localhost:5173 node e2e/walkthrough.mjs
 *
 * The script is NOT idempotent — reset the local chain (restart the node, redeploy, reseed) before re-running.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "screenshots");
fs.mkdirSync(OUT, { recursive: true });
const URL = process.env.BASE_URL || "http://localhost:5173/";
const PNG = process.env.FORM_IMAGE || path.join(here, "sample-ec8a.png");
const DEMO_ACCOUNTS = process.env.DEMO_ACCOUNTS || path.join(here, "..", "..", "contracts", "deployments", "demo-accounts.json");
const errors = [];
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => { errors.push(`pageerror: ${e.message}`); console.log("PAGEERROR", e.message); });
page.on("console", (m) => { if (m.type() === "error" && !/404|503/.test(m.text())) { errors.push(`console: ${m.text()}`); console.log("CONSOLE", m.text().slice(0, 400)); } });
process.on("uncaughtException", async (e) => { console.log("FAILED:", e.message.split("\n")[0]); try { await page.screenshot({ path: `${OUT}/zz-failure.png`, fullPage: true }); } catch {} process.exit(1); });

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
const pickRole = async (index) => {
  // HeroUI ComboBox: type the account number to filter, then pick the option
  await page.click("[data-testid=role-switcher-input]");
  await page.keyboard.type(`#${index}`);
  await page.click(`[data-testid=role-option-${index}]`);
  await page.waitForSelector("[data-testid=wallet-identity]", { timeout: 10000 });
  await page.waitForTimeout(1200);
};
const disconnect = async () => { await page.click("[data-testid=disconnect]"); await page.waitForTimeout(500); };
const waitToast = (text, timeout = 30000) => page.waitForSelector(`text=${text}`, { timeout });
const figureInputs = () => page.locator("[data-testid=figures-form] input");
/** Fills the EC8 figure fields in order (5 totals, then one per candidate) and commits the last one. */
const fillFigures = async (values) => {
  const inputs = figureInputs();
  for (let i = 0; i < values.length; i++) await inputs.nth(i).fill(String(values[i]));
  await page.keyboard.press("Tab");
};
const status = (s) => `[data-testid=unit-header] [data-status=${s}]`;
const confirmDialog = () => page.click("[data-testid=confirm-action]");
const demo = JSON.parse(fs.readFileSync(DEMO_ACCOUNTS, "utf8"));
const find = (pred) => demo.accounts.find(pred).index;
const agent = (level, unit, party) => find((a) => a.category === "PartyAgent" && a.level === level && a.unitId === unit && a.partyId === party);

const signAll = async (level, unit) => {
  for (const party of [1, 2, 3]) {
    await pickRole(agent(level, unit, party));
    await page.waitForSelector("button:has-text('Sign — figures are correct')", { timeout: 20000 });
    await page.click("button:has-text('Sign — figures are correct')");
    await waitToast("confirmed in block");
    await disconnect();
  }
};
const uploadPu = async (pu, values) => {
  await pickRole(find((a) => a.category === "PresidingOfficer" && a.unitId === pu));
  await page.waitForSelector("text=Upload EC8A result figures", { timeout: 20000 });
  await fillFigures(values);
  await page.setInputFiles("input[type=file]", PNG);
  await page.waitForSelector("text=Pinned (local)", { timeout: 10000 });
  await page.click("button:has-text('Submit to blockchain')");
  await waitToast("confirmed in block");
  await disconnect();
};
const collate = async (index, formLabel) => {
  await pickRole(index);
  await page.waitForSelector(`text=Declare ${formLabel} totals`, { timeout: 20000 });
  await page.click("button:has-text('Fill from computed aggregate')");
  await page.waitForSelector("text=Totals match the computed aggregate", { timeout: 10000 });
  await page.setInputFiles("input[type=file]", PNG);
  await page.waitForSelector("text=Pinned (local)", { timeout: 10000 });
  await page.click("button:has-text('Confirm collation on-chain')");
  await waitToast("confirmed in block");
  await disconnect();
};


await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector("text=Collation hierarchy", { timeout: 20000 });
await shot("01-public");
console.log("public portal rendered");

// click ward 3 in the tree
await page.click("button[data-testid^=tree-ward]:has-text('Ward 01 - Moniya')");
await page.waitForSelector("text=EC8B figures on-chain", { timeout: 10000 });
await shot("02-public-ward3");
console.log("ward detail rendered");

// ---- Presiding officer for PU 1 (index 4) uploads EC8A --------------------------------
await pickRole(4);
await page.waitForSelector("text=Upload EC8A result figures", { timeout: 15000 });
await shot("03-po-empty");
await fillFigures(["812", "300", "290", "285", "5", "150", "100", "35"]);
await page.waitForSelector("text=All arithmetic checks pass", { timeout: 5000 });
await page.setInputFiles("input[type=file]", PNG);
await page.waitForSelector("text=Pinned (local)", { timeout: 10000 });
await shot("04-po-filled");
await page.click("button:has-text('Submit to blockchain')");
await waitToast("confirmed in block");
await page.waitForSelector(status("PendingSignatures"), { timeout: 15000 });
await shot("05-po-submitted");
console.log("PO submitted EC8A");
await disconnect();

// ---- PA agent at PU 1 signs; DC agent raises a dispute ----------------------------------
await pickRole(agent(0, 1, 1));
await page.waitForSelector("text=Your decision as", { timeout: 15000 });
await shot("06-agent-review");
await page.click("button:has-text('Sign — figures are correct')");
await waitToast("confirmed in block");
await page.waitForSelector("text=You have signed", { timeout: 15000 });
console.log("PA agent signed");
await disconnect();

await pickRole(agent(0, 1, 2));
await page.waitForSelector("text=Your decision as", { timeout: 15000 });
await page.click("button:has-text('Reject — raise dispute')");
await page.fill("textarea", "The signed EC8A form shows 160 votes for PA, the upload says 150.");
await page.click("button:has-text('Raise dispute')");
await confirmDialog();
await waitToast("confirmed in block");
await page.waitForSelector(status("Frozen"), { timeout: 15000 });
await shot("07-agent-dispute");
console.log("DC agent raised a dispute -> Frozen");
await disconnect();

// ---- PO resolves by correcting the figures --------------------------------------------
await pickRole(4);
await page.waitForSelector("text=Correct the figures (dispute resolution)", { timeout: 15000 });
await fillFigures(["812", "310", "300", "295", "5", "160", "100", "35"]);
await page.waitForSelector("text=All arithmetic checks pass", { timeout: 5000 });
await page.setInputFiles("input[type=file]", PNG);
await page.waitForSelector("text=Pinned (local)", { timeout: 10000 });
await page.click("button:has-text('Resubmit corrected figures')");
await waitToast("confirmed in block");
await page.waitForSelector(status("Resolved"), { timeout: 15000 });
await shot("08-po-corrected");
console.log("PO corrected figures -> Resolved");
await disconnect();

// ---- DC agent accepts, then all three sign ---------------------------------------------
await pickRole(agent(0, 1, 2));
await page.waitForSelector("button:has-text('Accept resolution')", { timeout: 15000 });
await page.click("button:has-text('Accept resolution')");
await waitToast("confirmed in block");
await page.waitForSelector("button:has-text('Sign — figures are correct')", { timeout: 15000 });
await page.click("button:has-text('Sign — figures are correct')");
await waitToast("confirmed in block");
await disconnect();
for (const party of [1, 3]) {
  await pickRole(agent(0, 1, party));
  await page.waitForSelector("button:has-text('Sign — figures are correct')", { timeout: 15000 });
  if (party === 3) {
    await page.click("button:has-text('Sign with objection')");
    await page.fill("textarea", "Agent was kept outside during counting");
    await page.click("button:has-text('Sign with objection')");
  } else {
    await page.click("button:has-text('Sign — figures are correct')");
  }
  await waitToast("confirmed in block");
  await disconnect();
}
await page.goto(URL, { waitUntil: "networkidle" });
await page.click("button[data-testid^=tree-pu]:has-text('OY/11/01/001')");
await page.waitForSelector(status("Approved"), { timeout: 15000 });
await shot("09-pu1-approved");
console.log("PU 1 approved after re-signing (with one objection)");

// ---- PO of PU 2 uploads, agents sign quickly ------------------------------------------
await pickRole(5);
await page.waitForSelector("text=Upload EC8A result figures", { timeout: 15000 });
await fillFigures(["954", "400", "390", "380", "10", "200", "120", "60"]);
await page.setInputFiles("input[type=file]", PNG);
await page.waitForSelector("text=Pinned (local)", { timeout: 10000 });
await page.click("button:has-text('Submit to blockchain')");
await waitToast("confirmed in block");
await disconnect();
for (const party of [1, 2, 3]) {
  await pickRole(agent(0, 2, party));
  await page.waitForSelector("button:has-text('Sign — figures are correct')", { timeout: 15000 });
  await page.click("button:has-text('Sign — figures are correct')");
  await waitToast("confirmed in block");
  await disconnect();
}
console.log("PU 2 approved");

// ---- Ward 1 collation officer: mismatch first, then honest ---------------------------------
const wardCo = demo.accounts.find((a) => a.category === "WardCollationOfficer" && a.unitId === 1).index;
await pickRole(wardCo);
await page.waitForSelector("text=Declare EC8B totals", { timeout: 15000 });
await page.click("button:has-text('Fill from computed aggregate')");
await page.waitForSelector("text=Totals match the computed aggregate", { timeout: 10000 });
// tamper candidate A (+100)
const candInput = figureInputs().nth(5);
await candInput.fill(String(Number((await candInput.inputValue()).replace(/\D/g, "")) + 100));
await page.keyboard.press("Tab");
await page.waitForSelector("text=Mismatch on CandidateVotes", { timeout: 10000 });
await shot("10-ward-mismatch-precheck");
await page.setInputFiles("input[type=file]", PNG);
await page.waitForSelector("text=Pinned (local)", { timeout: 10000 });
await page.click("button:has-text('Confirm collation on-chain')");
await waitToast("confirmed in block");
await page.waitForSelector("text=mismatch alert(s) are permanently recorded", { timeout: 15000 });
await shot("11-ward-mismatch-recorded");
console.log("ward mismatch recorded on-chain and collation blocked");
await page.click("button:has-text('Fill from computed aggregate')");
await page.waitForSelector("text=Totals match the computed aggregate", { timeout: 10000 });
await page.click("button:has-text('Confirm collation on-chain')");
await waitToast("confirmed in block");
await page.waitForSelector(status("PendingSignatures"), { timeout: 15000 });
await shot("12-ward-confirmed");
console.log("ward 1 collation confirmed");
await disconnect();

// ---- Auditor portal & publisher portal render --------------------------------------------
await pickRole(2);
await page.waitForSelector("text=Audit readiness", { timeout: 15000 });
await page.waitForSelector("text=Full chain trace", { timeout: 15000 });
await page.waitForTimeout(2000);
await shot("13-auditor");
await disconnect();
await pickRole(3);
await page.waitForSelector("text=Declaration gate", { timeout: 15000 });
await shot("14-publisher");
await disconnect();
await pickRole(0);
await page.waitForSelector("text=INEC administration", { timeout: 15000 });
await shot("15-admin");
await page.click("[data-testid=admin-tab-stakeholders]");
await page.waitForTimeout(800);
await shot("16-admin-stakeholders");
await disconnect();


// ---- remaining chain up to the declaration ----

// ward 1 agents sign the EC8B
await signAll(1, 1);
console.log("ward 1 approved");
// PUs 3 & 4 (ward 2)
await uploadPu(3, [1103, 500, 480, 470, 10, 250, 150, 70]);
await signAll(0, 3);
await uploadPu(4, [776, 350, 340, 330, 10, 170, 110, 50]);
await signAll(0, 4);
console.log("PUs 3-4 approved");
await collate(find((a) => a.category === "WardCollationOfficer" && a.unitId === 2), "EC8B");
await signAll(1, 2);
console.log("ward 2 approved");
// LGAs
await collate(find((a) => a.category === "LgaCollationOfficer" && a.unitId === 1), "EC8C");
await signAll(2, 1);
await collate(find((a) => a.category === "LgaCollationOfficer" && a.unitId === 2), "EC8C");
await signAll(2, 2);
console.log("LGAs approved");
// State
await collate(1, "EC8D");
await signAll(3, 1);
console.log("state approved");

// Auditor: sign digest + record
await pickRole(2);
await page.waitForSelector("text=Sign the state result hash", { timeout: 20000 });
await page.setInputFiles("input[type=file]", PNG);
await page.waitForSelector("text=Pinned (local)", { timeout: 10000 });
await page.click("button:has-text('1. Sign digest with wallet')");
await waitToast("Audit digest signed");
await page.click("button:has-text('2. Record verification on-chain')");
await waitToast("confirmed in block");
await page.waitForSelector("text=Audit approval recorded", { timeout: 20000 });
await page.waitForTimeout(1500);
await shot("17-auditor-signed");
console.log("auditor signed and recorded");
await disconnect();

// Publisher declares
await pickRole(3);
await page.waitForSelector("button:has-text('Declare the final result')", { timeout: 20000 });
await page.click("button:has-text('Declare the final result')");
await confirmDialog();
await waitToast("confirmed in block");
await page.waitForSelector("text=Declared result", { timeout: 20000 });
await page.waitForTimeout(1000);
await shot("18-declared");
console.log("result declared");
await disconnect();

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector("text=Declared result", { timeout: 20000 });
await shot("19-public-declared");

await browser.close();
console.log("\nERRORS:", errors.length ? errors : "none");

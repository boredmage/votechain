/**
 * Live simulation on a running node (Hardhat node or Anvil): deploys a fresh VoteChain system,
 * builds an Oyo-style geography and drives the complete collation chain while measuring
 * wall-clock throughput, end-to-end latency and gas (Section 3.11.2).
 *
 *   SCALE=small  npx hardhat run hardhat/simulate.js --network localhost   # 1 ward,  10 PUs
 *   SCALE=medium npx hardhat run hardhat/simulate.js --network localhost   # 1 LGA,   30 wards x 10 PUs
 *   SCALE=large  npx hardhat run hardhat/simulate.js --network localhost   # 5 LGAs, 10 wards x 12 PUs
 *
 * Because the number of distinct stakeholder wallets grows with the geography, the script derives
 * throw-away wallets from the test mnemonic and funds them from account #0.
 * Results are written to benchmarks/live-<scale>.json.
 */
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const { ethers } = hre;
const { deploySystem, figures, toFigures, signAudit, Level, STATE_UNIT_ID, DEMO_CID, TEST_MNEMONIC } = require("./lib");

const SCALES = {
  small: { lgas: 1, wardsPerLga: 1, pusPerWard: 10 },
  medium: { lgas: 1, wardsPerLga: 30, pusPerWard: 10 },
  large: { lgas: 5, wardsPerLga: 10, pusPerWard: 12 },
};
const PARTIES = 3;

async function main() {
  const scale = process.env.SCALE || "small";
  const cfg = SCALES[scale];
  if (!cfg) throw new Error(`unknown SCALE ${scale}; use ${Object.keys(SCALES).join("|")}`);
  const [admin] = await ethers.getSigners();
  const provider = ethers.provider;

  // ---- wallets ---------------------------------------------------------
  const root = ethers.HDNodeWallet.fromPhrase(TEST_MNEMONIC, undefined, "m/44'/60'/0'/0");
  let nextIndex = 100; // leave the first 100 accounts for the demo
  const wallets = [];
  const newWallet = () => {
    const w = root.deriveChild(nextIndex++).connect(provider);
    wallets.push(w);
    return w;
  };
  const gasUsed = {};
  const rec = async (label, txPromise) => {
    const receipt = await (await txPromise).wait();
    const g = gasUsed[label] || { count: 0, total: 0n };
    g.count += 1;
    g.total += receipt.gasUsed;
    gasUsed[label] = g;
    return receipt;
  };

  console.log(`\nVoteChain live simulation — scale=${scale}: ${cfg.lgas} LGA(s) x ${cfg.wardsPerLga} wards x ${cfg.pusPerWard} PUs`);
  const t0 = Date.now();
  const { election, upload, verification, collation, audit } = await deploySystem(admin);
  const em = election.connect(admin);
  await (await em.setElectionInfo("Simulation", "Governorship", "Oyo", Math.floor(Date.now() / 1000), 0)).wait();

  // ---- configuration ---------------------------------------------------
  for (let p = 1; p <= PARTIES; p++) {
    await (await em.addParty(`Party ${p}`, `P${p}`)).wait();
    await (await em.addCandidate(p, `Candidate ${p}`)).wait();
  }
  const po = {};
  const wardCo = {};
  const lgaCo = {};
  const agents = {}; // `${level}-${unit}` -> [wallets]
  const sro = newWallet();
  const auditor = newWallet();
  const publisher = newWallet();
  for (let l = 1; l <= cfg.lgas; l++) {
    await (await em.addLga(`LGA ${l}`)).wait();
    for (let w = 1; w <= cfg.wardsPerLga; w++) {
      const wardId = Number(await em.wardCount()) + 1;
      await (await em.addWard(l, `Ward ${w}`)).wait();
      const codes = [], names = [], regs = [];
      for (let p = 1; p <= cfg.pusPerWard; p++) {
        codes.push(`OY/${l}/${w}/${p}`);
        names.push(`PU ${p}`);
        regs.push(1000);
      }
      await (await em.addPollingUnits(wardId, codes, names, regs)).wait();
      wardCo[wardId] = newWallet();
      agents[`${Level.Ward}-${wardId}`] = Array.from({ length: PARTIES }, newWallet);
    }
    lgaCo[l] = newWallet();
    agents[`${Level.LGA}-${l}`] = Array.from({ length: PARTIES }, newWallet);
  }
  agents[`${Level.State}-${STATE_UNIT_ID}`] = Array.from({ length: PARTIES }, newWallet);
  const puCount = Number(await em.pollingUnitCount());
  const wardCount = Number(await em.wardCount());
  for (let pu = 1; pu <= puCount; pu++) {
    po[pu] = newWallet();
    agents[`${Level.PollingUnit}-${pu}`] = Array.from({ length: PARTIES }, newWallet);
  }

  // fund every wallet (0.5 ETH each is plenty on a local node)
  console.log(`funding ${wallets.length} stakeholder wallets...`);
  let nonce = await provider.getTransactionCount(admin.address);
  const funding = wallets.map((w) => admin.sendTransaction({ to: w.address, value: ethers.parseEther("0.5"), nonce: nonce++ }));
  await Promise.all((await Promise.all(funding)).map((tx) => tx.wait()));

  console.log("registering stakeholders...");
  for (let pu = 1; pu <= puCount; pu++) {
    await (await em.registerPresidingOfficer(po[pu].address, pu)).wait();
  }
  for (let w = 1; w <= wardCount; w++) await (await em.registerWardCollationOfficer(wardCo[w].address, w)).wait();
  for (let l = 1; l <= cfg.lgas; l++) await (await em.registerLgaCollationOfficer(lgaCo[l].address, l)).wait();
  await (await em.registerStateReturningOfficer(sro.address)).wait();
  await (await em.registerAuditor(auditor.address)).wait();
  await (await em.registerResultPublisher(publisher.address)).wait();
  for (const [key, list] of Object.entries(agents)) {
    const [level, unit] = key.split("-").map(Number);
    await (
      await em.registerPartyAgents(
        list.map((w) => w.address),
        list.map((_, i) => i + 1),
        level,
        list.map(() => unit),
      )
    ).wait();
  }
  await (await em.activateElection()).wait();
  const tConfigured = Date.now();
  console.log(`configured in ${((tConfigured - t0) / 1000).toFixed(1)}s — starting collation chain`);

  // ---- collation chain -------------------------------------------------
  const signAll = async (level, unitId, label) => {
    const h = await verification.currentFiguresHash(level, unitId);
    const list = agents[`${level}-${unitId}`];
    await Promise.all(list.map((w) => rec(label, verification.connect(w).signResult(level, unitId, h))));
  };
  const tStart = Date.now();
  for (let pu = 1; pu <= puCount; pu++) {
    const a = 100 + ((pu * 7) % 150), b = 100 + ((pu * 11) % 150), c = 100 + ((pu * 13) % 150);
    const valid = a + b + c, rej = pu % 6, cast = valid + rej;
    const f = figures(1000, cast + 15, cast, valid, rej, [a, b, c]);
    await rec("po.submitResult", upload.connect(po[pu]).submitResult(pu, f, DEMO_CID));
    await signAll(Level.PollingUnit, pu, "agent.signResult");
  }
  const tPus = Date.now();
  const collate = async (level, unitId, officer, label) => {
    const [agg, complete] = await collation.computeAggregate(level, unitId);
    if (!complete) throw new Error(`incomplete ${level}/${unitId}`);
    await rec(label, collation.connect(officer).confirmCollation(level, unitId, toFigures(agg), DEMO_CID));
    await signAll(level, unitId, "agent.signResult");
  };
  for (let w = 1; w <= wardCount; w++) await collate(Level.Ward, w, wardCo[w], "officer.confirmCollation.ward");
  for (let l = 1; l <= cfg.lgas; l++) await collate(Level.LGA, l, lgaCo[l], "officer.confirmCollation.lga");
  await collate(Level.State, STATE_UNIT_ID, sro, "officer.confirmCollation.state");
  const sig = await signAudit(auditor, audit);
  await rec("auditor.verifyAndSign", audit.connect(auditor).verifyAndSign(sig, DEMO_CID));
  await rec("publisher.declareResult", audit.connect(publisher).declareResult());
  const tEnd = Date.now();

  // ---- report ----------------------------------------------------------
  const decl = await audit.getDeclaration();
  const chainSeconds = (tEnd - tStart) / 1000;
  const puSeconds = (tPus - tStart) / 1000;
  const totalGas = Object.values(gasUsed).reduce((s, g) => s + g.total, 0n);
  const report = {
    scale,
    ...cfg,
    pollingUnits: puCount,
    wards: wardCount,
    parties: PARTIES,
    network: hre.network.name,
    configurationSeconds: (tConfigured - t0) / 1000,
    pollingUnitPhaseSeconds: puSeconds,
    submissionsPerMinute: Math.round((puCount / puSeconds) * 60),
    endToEndLatencySeconds: chainSeconds,
    declared: decl.declared,
    winnerCandidateIndex: Number(decl.winnerCandidateIndex),
    totalGasUsed: totalGas.toString(),
    txTypes: Object.fromEntries(
      Object.entries(gasUsed).map(([k, g]) => [k, { count: g.count, totalGas: g.total.toString(), avgGas: (g.total / BigInt(g.count)).toString() }]),
    ),
  };
  const out = path.join(__dirname, "..", "benchmarks", `live-${scale}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nwrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

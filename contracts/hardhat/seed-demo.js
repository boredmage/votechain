/**
 * Configures the demonstration election on a local node (anvil or `hardhat node`) and writes
 * deployments/demo-accounts.json with a known account for every stakeholder role.
 *
 * Geography: data/oyo-register.json — the whole of Oyo State as INEC registers it: 33 LGAs, 351 wards
 * and 6,390 polling units, with INEC's names and codes (see scripts/build-oyo-register.mjs). Three
 * fictional parties. That makes 27,103 stakeholder wallets: 4 state-level, 6,390 presiding officers,
 * 351 ward and 33 LGA collation officers, and one agent per party at each of the 6,775 units. They
 * are derived from the public test mnemonic and funded here with hardhat_setBalance, so the node
 * itself needs no extra accounts. Seeding is some 35,000 transactions (about 12 billion gas). A
 * local node recomputes its state root for every block, so the seed switches it from automine to
 * one large block a second while it runs (and back afterwards): many transactions share each block.
 *
 *   SEED_LGAS=3 ...   # only the first three LGAs of the register — a quick election for development
 *
 *   npx hardhat run hardhat/seed-demo.js --network localhost                      # prefill "live" (default)
 *   DEMO_PREFILL=none     npx hardhat run hardhat/seed-demo.js --network localhost # configured + activated, nothing uploaded
 *   DEMO_PREFILL=all      npx hardhat run hardhat/seed-demo.js --network localhost # every unit approved up to the state; awaiting the audit
 *   DEMO_PREFILL=declared npx hardhat run hardhat/seed-demo.js --network localhost # audited and declared: the finished election
 *
 * "live" approves everything except a small slice left for a live walkthrough: polling units 1 and 2,
 * and therefore ward 1, LGA 1 and the state result (see docs/DEMO_WALKTHROUGH.md).
 */
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const { ethers, network } = hre;
const { attachSystem, loadRegister, hdRoot, demoFigures, toFigures, signAudit, Level, STATE_UNIT_ID, DEMO_CID, TEST_MNEMONIC } =
  require("./lib");

/** none | live | all | declared — how far the demo election is driven after activation. */
const PREFILL_ALIASES = { "": "live", 0: "none", 1: "live", lga: "live" };
const rawPrefill = String(process.env.DEMO_PREFILL ?? "").toLowerCase();
const PREFILL = PREFILL_ALIASES[rawPrefill] ?? rawPrefill;
const PREFILL_LEVELS = ["none", "live", "all", "declared"];

/** Units left open by the "live" prefill, for the walkthrough. */
const LIVE_PUS = [1, 2];

const PARTIES = [
  ["Progressive Alliance", "PA", "Adebayo Ogunleye"],
  ["Democratic Congress", "DC", "Folasade Akintola"],
  ["Labour Front", "LF", "Chukwuemeka Balogun"],
];
const LEVEL_NAME = ["PU", "Ward", "LGA", "State"];
const AGENT_BATCH = 100; // registerPartyAgents entries per transaction
const PU_BATCH = 40; // addPollingUnits entries per transaction (the largest ward has 133)
const CONCURRENCY = Number(process.env.SEED_CONCURRENCY || 200); // units prefilled in parallel
// Generous: a node only keeps a queued transaction its sender can pay for at the full gas limit and
// fee cap, and the admin has hundreds of 20M-gas batches queued at once.
const DEMO_BALANCE = ethers.toBeHex(ethers.parseEther("100000"));
const SEED_BLOCK_GAS = 300_000_000; // block gas limit while seeding
const NODE_BLOCK_GAS = 30_000_000; // ...and the node's default, restored afterwards
// Fixed fees and gas limits: no fee, estimate or nonce round trip per transaction, and a transaction can
// be sent before the ones it depends on are mined. Limits are measured use plus headroom.
const FEES = { maxFeePerGas: ethers.parseUnits("3", "gwei"), maxPriorityFeePerGas: ethers.parseUnits("1", "gwei") };
const GAS = {
  simple: 400_000n, // election info, a party, a candidate, an LGA, one officer (~125k)
  wards: (n) => 100_000n + 150_000n * BigInt(n), // ~110k per ward
  pollingUnits: (n) => 100_000n + 220_000n * BigInt(n), // ~155k per polling unit
  agents: (n) => 100_000n + 200_000n * BigInt(n), // ~165k per agent
  submit: 800_000n, // ~515k
  // The agents of a unit sign in parallel and the last signature to land also approves the unit, which
  // an estimate made before the others were mined would not cover.
  sign: 500_000n, // ~190k
};

const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
const send = async (p) => (await p).wait();

/** Runs `fn` over `items` with at most `limit` in flight. */
async function pool(items, limit, fn) {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < items.length && !failed) {
      try {
        await fn(items[next++]);
      } catch (err) {
        failed = true; // the other workers finish their current unit and stop
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function main() {
  if (!PREFILL_LEVELS.includes(PREFILL)) throw new Error(`DEMO_PREFILL must be one of ${PREFILL_LEVELS.join(", ")} (got "${rawPrefill}")`);
  // A plain JSON-RPC provider rather than Hardhat's: it folds concurrent calls into batched requests
  // over kept-alive connections, which tens of thousands of receipt polls need.
  const provider = new ethers.JsonRpcProvider(network.config.url || "http://127.0.0.1:8545", undefined, { staticNetwork: true, batchMaxCount: 200 });
  provider.pollingInterval = 500;
  const system = await attachSystem(network.name);
  const [election, upload, verification, collation, audit] = ["election", "upload", "verification", "collation", "audit"].map((k) => system[k].connect(provider));
  const register = loadRegister();
  const lgaLimit = Number(process.env.SEED_LGAS || 0);
  if (lgaLimit > 0) register.lgas = register.lgas.slice(0, lgaLimit);
  const root = hdRoot();
  const wallets = new Map();
  const wallet = (i) => {
    if (!wallets.has(i)) wallets.set(i, root.deriveChild(i).connect(provider));
    return wallets.get(i);
  };

  // ---- the register, flattened to the contract's sequential ids ---------------------------
  const lgas = []; // { id, name }
  const wards = []; // { id, lgaId, name, label }
  const pus = []; // { id, wardId, lgaId, code, name, registeredVoters }
  for (const l of register.lgas) {
    const lga = { id: lgas.length + 1, name: l.name, wards: l.wards };
    lgas.push(lga);
    for (const w of l.wards) {
      const ward = { id: wards.length + 1, lgaId: lga.id, name: w.name, label: `${w.name} (${l.name})`, pollingUnits: w.pollingUnits };
      wards.push(ward);
      for (const p of w.pollingUnits) pus.push({ id: pus.length + 1, wardId: ward.id, lgaId: lga.id, ...p });
    }
  }

  // ---- account book: mnemonic index -> role ---------------------------------------------
  const accounts = [];
  const record = (index, role, category, level, unitId, partyId) => {
    const w = wallet(index);
    accounts.push({ index, role, category, level, unitId: Number(unitId), partyId, address: w.address, privateKey: w.privateKey });
    return w.address;
  };
  let next = 0;
  record(next++, "INEC Admin", "InecAdmin", 0, 0, 0);
  const sro = record(next++, "State Returning Officer", "StateReturningOfficer", Level.State, STATE_UNIT_ID, 0);
  const auditor = record(next++, "Independent State Auditor", "Auditor", Level.State, STATE_UNIT_ID, 0);
  const publisher = record(next++, "State Result Publisher", "ResultPublisher", Level.State, STATE_UNIT_ID, 0);
  const SRO = 1;
  const AUDITOR = 2;
  const PUBLISHER = 3;

  const poIndex = {};
  const wardCoIndex = {};
  const lgaCoIndex = {};
  const agentIndex = {}; // `${level}-${unit}-${party}` -> index
  for (const pu of pus) record((poIndex[pu.id] = next++), `Presiding Officer - ${pu.code} ${pu.name}`, "PresidingOfficer", Level.PollingUnit, pu.id, 0);
  for (const w of wards) record((wardCoIndex[w.id] = next++), `Ward Collation Officer - ${w.label}`, "WardCollationOfficer", Level.Ward, w.id, 0);
  for (const l of lgas) record((lgaCoIndex[l.id] = next++), `LGA Collation Officer - ${l.name}`, "LgaCollationOfficer", Level.LGA, l.id, 0);
  const agents = { [Level.PollingUnit]: [], [Level.Ward]: [], [Level.LGA]: [], [Level.State]: [] };
  PARTIES.forEach(([, acronym], p) => {
    const party = p + 1;
    const agent = (level, unitId, label) => {
      const index = (agentIndex[`${level}-${unitId}-${party}`] = next++);
      agents[level].push({ address: record(index, `${acronym} Agent - ${LEVEL_NAME[level]} ${label}`, "PartyAgent", level, unitId, party), party, unitId });
    };
    for (const pu of pus) agent(Level.PollingUnit, pu.id, `${pu.code} ${pu.name}`);
    for (const w of wards) agent(Level.Ward, w.id, w.label);
    for (const l of lgas) agent(Level.LGA, l.id, l.name);
    agent(Level.State, STATE_UNIT_ID, `${register.state} State`);
  });
  console.log(`Register: ${lgas.length} LGAs, ${wards.length} wards, ${pus.length} polling units -> ${accounts.length} stakeholder accounts.`);

  // ---- fund every account (local nodes only) --------------------------------------------
  let setBalance = null;
  for (const method of ["hardhat_setBalance", "anvil_setBalance"]) {
    try {
      await provider.send(method, [accounts[0].address, DEMO_BALANCE]);
      setBalance = method;
      break;
    } catch {
      /* not this client — try the other one */
    }
  }
  if (!setBalance) throw new Error("The node supports neither hardhat_setBalance nor anvil_setBalance: the demo seed only runs on a local chain.");
  for (const batch of chunks(accounts, 200)) await Promise.all(batch.map((a) => provider.send(setBalance, [a.address, DEMO_BALANCE])));
  console.log(`Funded ${accounts.length} accounts (${setBalance}).`);

  // ---- mining mode: one large block a second while seeding ---------------------------------
  const mining = async (seeding) => {
    try {
      await provider.send("evm_setBlockGasLimit", [ethers.toBeHex(seeding ? SEED_BLOCK_GAS : NODE_BLOCK_GAS)]);
    } catch {
      /* the node keeps its own limit: more, smaller blocks */
    }
    // Order matters: on anvil the two modes are exclusive and the last call wins (interval 0 means
    // "do not mine"), on Hardhat they are independent switches.
    if (seeding) {
      await provider.send("evm_setAutomine", [false]);
      await provider.send("evm_setIntervalMining", [1]);
    } else {
      await provider.send("evm_setIntervalMining", [0]);
      await provider.send("evm_setAutomine", [true]);
    }
  };
  await mining(true);
  try {
    await seed();
  } finally {
    await mining(false);
  }

  async function seed() {
  // ---- configuration (Registration phase, signed by the INEC admin) ---------------------
  // Sent in nonce order without waiting for each to be mined; receipts are checked in batches.
  const em = election.connect(wallet(0));
  let nonce = await provider.getTransactionCount(wallet(0).address);
  const sent = [];
  const settle = async () => Promise.all(sent.splice(0).map((tx) => tx.wait()));
  let queuedGas = 0n;
  const admin = async (method, args, gasLimit = GAS.simple) => {
    sent.push(await em[method](...args, { ...FEES, gasLimit, nonce: nonce++ }));
    queuedGas += gasLimit;
    // keep about two blocks' worth queued: enough to fill every block, never a backlog the node may drop
    if (sent.length >= 400 || queuedGas >= 2n * BigInt(SEED_BLOCK_GAS)) {
      await settle();
      queuedGas = 0n;
    }
  };
  await admin("setElectionInfo", [`2027 ${register.state} State Governorship Election (Demo)`, "Governorship", register.state, Math.floor(Date.now() / 1000), 0]);
  for (const [name, acronym] of PARTIES) await admin("addParty", [name, acronym]);
  for (let p = 0; p < PARTIES.length; p++) await admin("addCandidate", [p + 1, PARTIES[p][2]]);

  for (const l of lgas) await admin("addLga", [l.name]);
  for (const l of lgas) await admin("addWards", [l.id, l.wards.map((w) => w.name)], GAS.wards(l.wards.length));
  for (const w of wards) {
    for (const list of chunks(w.pollingUnits, PU_BATCH)) {
      await admin("addPollingUnits", [w.id, list.map((p) => p.code), list.map((p) => p.name), list.map((p) => p.registeredVoters)], GAS.pollingUnits(list.length));
    }
  }
  await settle();
  console.log("Geography loaded.");

  await admin("registerStateReturningOfficer", [sro]);
  await admin("registerAuditor", [auditor]);
  await admin("registerResultPublisher", [publisher]);
  for (const pu of pus) await admin("registerPresidingOfficer", [wallet(poIndex[pu.id]).address, pu.id]);
  for (const w of wards) await admin("registerWardCollationOfficer", [wallet(wardCoIndex[w.id]).address, w.id]);
  for (const l of lgas) await admin("registerLgaCollationOfficer", [wallet(lgaCoIndex[l.id]).address, l.id]);
  for (const level of [Level.PollingUnit, Level.Ward, Level.LGA, Level.State]) {
    for (const batch of chunks(agents[level], AGENT_BATCH)) {
      await admin("registerPartyAgents", [batch.map((a) => a.address), batch.map((a) => a.party), level, batch.map((a) => a.unitId)], GAS.agents(batch.length));
    }
  }
  await settle();
  console.log("Stakeholders registered.");

  await admin("activateElection", []);
  await settle();
  console.log("Demo election configured and activated.");

  if (PREFILL !== "none") {
    const signAll = async (level, unitId) => {
      const h = await verification.currentFiguresHash(level, unitId);
      await Promise.all(
        PARTIES.map((_, p) => send(verification.connect(wallet(agentIndex[`${level}-${unitId}-${p + 1}`])).signResult(level, unitId, h, { ...FEES, gasLimit: GAS.sign }))),
      );
    };
    const uploadPu = async (pu) => {
      await send(upload.connect(wallet(poIndex[pu.id])).submitResult(pu.id, demoFigures(pu.id, pu.registeredVoters), DEMO_CID, { ...FEES, gasLimit: GAS.submit }));
      await signAll(Level.PollingUnit, pu.id);
    };
    const collate = async (level, unitId, officerIndex) => {
      const [agg, complete] = await collation.computeAggregate(level, unitId);
      if (!complete) throw new Error(`${LEVEL_NAME[level]} ${unitId} incomplete`);
      await send(collation.connect(wallet(officerIndex)).confirmCollation(level, unitId, toFigures(agg), DEMO_CID, FEES));
      await signAll(level, unitId);
    };
    const progress = async (label, items, fn) => {
      let done = 0;
      await pool(items, CONCURRENCY, async (item) => {
        await fn(item);
        if (++done % 500 === 0 || done === items.length) console.log(`  ${label}: ${done}/${items.length}`);
      });
    };

    const live = PREFILL === "live";
    const openPus = new Set(live ? LIVE_PUS : []);
    const openWards = new Set(pus.filter((p) => openPus.has(p.id)).map((p) => p.wardId));
    const openLgas = new Set(pus.filter((p) => openPus.has(p.id)).map((p) => p.lgaId));

    await progress("polling units approved", pus.filter((p) => !openPus.has(p.id)), uploadPu);
    await progress("wards approved", wards.filter((w) => !openWards.has(w.id)), (w) => collate(Level.Ward, w.id, wardCoIndex[w.id]));
    if (!live) await send(em.closeSubmissions(FEES)); // Active -> Collation: every polling unit has reported
    await progress("LGAs approved", lgas.filter((l) => !openLgas.has(l.id)), (l) => collate(Level.LGA, l.id, lgaCoIndex[l.id]));
    if (live) {
      const ward = wards.find((w) => openWards.has(w.id));
      console.log(`Prefilled everything except the live slice: polling units ${LIVE_PUS.join(" and ")}, ward ${ward.id} (${ward.label}), LGA ${ward.lgaId} and the state result.`);
    } else {
      await collate(Level.State, STATE_UNIT_ID, SRO);
      console.log(`Prefilled every level: ${pus.length} polling units, ${wards.length} wards, ${lgas.length} LGAs and the state result approved (phase Collation).`);
      if (PREFILL === "declared") {
        const sig = await signAudit(wallet(AUDITOR), audit);
        await send(audit.connect(wallet(AUDITOR)).verifyAndSign(sig, DEMO_CID));
        await send(audit.connect(wallet(PUBLISHER)).declareResult());
        console.log("Audit signed by the auditor and result declared by the publisher (phase Declared).");
      } else {
        console.log(`Next: act as the Independent Auditor (#${AUDITOR}) to sign, then the Result Publisher (#${PUBLISHER}) to declare.`);
      }
    }
  }

  } // seed()

  const { chainId } = await provider.getNetwork();
  const out = path.join(__dirname, "..", "deployments", "demo-accounts.json");
  const head = { chainId: Number(chainId), mnemonic: TEST_MNEMONIC, warning: "Publicly known test keys - never use on a real network" };
  // one account per line: the file stays diffable without being pretty-printed to several megabytes
  fs.writeFileSync(out, `${JSON.stringify(head, null, 2).slice(0, -2)},\n  "accounts": [\n${accounts.map((a) => `    ${JSON.stringify(a)}`).join(",\n")}\n  ]\n}\n`);
  console.log(`wrote ${out} (${accounts.length} accounts)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

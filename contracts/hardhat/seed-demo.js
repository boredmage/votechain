/**
 * Configures the demonstration election (2 LGAs x 2 wards x 2 polling units, 3 parties) on a local
 * node and writes deployments/demo-accounts.json with a known account for every stakeholder role.
 * Mirrors script/SeedDemo.s.sol.
 *
 *   npx hardhat run hardhat/seed-demo.js --network localhost                      # configured + activated, nothing uploaded
 *   DEMO_PREFILL=lga      npx hardhat run hardhat/seed-demo.js --network localhost # LGA 2 pre-collated (DEMO_PREFILL=1 is an alias)
 *   DEMO_PREFILL=all      npx hardhat run hardhat/seed-demo.js --network localhost # every unit approved up to the state; awaiting the audit
 *   DEMO_PREFILL=declared npx hardhat run hardhat/seed-demo.js --network localhost # audited and declared: the finished election
 */
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const { ethers, network } = hre;
const { attachSystem, walletAt, demoFigures, toFigures, signAudit, Level, STATE_UNIT_ID, DEMO_CID, TEST_MNEMONIC } =
  require("./lib");

/** none | lga | all | declared — how far the demo election is driven after activation. */
const PREFILL = { "": "none", 0: "none", 1: "lga" }[process.env.DEMO_PREFILL ?? ""] ?? String(process.env.DEMO_PREFILL).toLowerCase();
const PREFILL_LEVELS = ["none", "lga", "all", "declared"];

const PARTIES = 3;
const LEVEL_NAME = ["PU", "Ward", "LGA", "State"];

async function main() {
  const signers = await ethers.getSigners();
  if (signers.length < 63) throw new Error("This script needs at least 63 accounts (see hardhat.config.js accounts.count)");
  if (!PREFILL_LEVELS.includes(PREFILL)) throw new Error(`DEMO_PREFILL must be one of ${PREFILL_LEVELS.join(", ")} (got "${PREFILL}")`);
  const { election, upload, verification, collation, audit } = await attachSystem(network.name);
  const admin = signers[0];
  const em = election.connect(admin);
  const accounts = [];
  let next = 4;

  const record = (index, role, category, level, unitId, partyId) => {
    accounts.push({
      index,
      role,
      category,
      level,
      unitId: Number(unitId),
      partyId: Number(partyId),
      address: signers[index].address,
      privateKey: walletAt(index).privateKey,
    });
  };
  const send = async (p) => (await p).wait();

  record(0, "INEC Admin", "InecAdmin", 0, 0, 0);
  await send(em.setElectionInfo("2027 Oyo State Governorship Election (Demo)", "Governorship", "Oyo", Math.floor(Date.now() / 1000), 0));

  await send(em.addParty("Progressive Alliance", "PA"));
  await send(em.addParty("Democratic Congress", "DC"));
  await send(em.addParty("Labour Front", "LF"));
  await send(em.addCandidate(1, "Adebayo Ogunleye"));
  await send(em.addCandidate(2, "Folasade Akintola"));
  await send(em.addCandidate(3, "Chukwuemeka Balogun"));

  await send(em.addLga("Ibadan North"));
  await send(em.addLga("Akinyele"));
  await send(em.addWard(1, "Ward 01 - Agbowo"));
  await send(em.addWard(1, "Ward 02 - Bodija"));
  await send(em.addWard(2, "Ward 01 - Moniya"));
  await send(em.addWard(2, "Ward 02 - Ojoo"));
  const pus = [
    [1, "OY/11/01/001", "Community Primary School I", 812],
    [1, "OY/11/01/002", "Community Primary School II", 954],
    [2, "OY/11/02/001", "Bodija Market Square", 1103],
    [2, "OY/11/02/002", "Bodija Estate Hall", 776],
    [3, "OY/01/01/001", "Moniya Central Mosque Front", 998],
    [3, "OY/01/01/002", "Moniya Motor Park", 1240],
    [4, "OY/01/02/001", "Ojoo Baptist Primary School", 867],
    [4, "OY/01/02/002", "Ojoo Bus Stop Open Space", 1015],
  ];
  for (const [ward, code, name, reg] of pus) await send(em.addPollingUnit(ward, code, name, reg));

  await send(em.registerStateReturningOfficer(signers[1].address));
  record(1, "State Returning Officer", "StateReturningOfficer", Level.State, STATE_UNIT_ID, 0);
  await send(em.registerAuditor(signers[2].address));
  record(2, "Independent State Auditor", "Auditor", Level.State, STATE_UNIT_ID, 0);
  await send(em.registerResultPublisher(signers[3].address));
  record(3, "State Result Publisher", "ResultPublisher", Level.State, STATE_UNIT_ID, 0);

  const poIndex = {};
  const wardCoIndex = {};
  const agentIndex = {}; // `${level}-${unit}-${party}` -> index
  for (let pu = 1; pu <= 8; pu++) {
    const i = next++;
    poIndex[pu] = i;
    await send(em.registerPresidingOfficer(signers[i].address, pu));
    record(i, `Presiding Officer - ${pus[pu - 1][1]}`, "PresidingOfficer", Level.PollingUnit, pu, 0);
  }
  const wardNames = ["Ward 01 - Agbowo", "Ward 02 - Bodija", "Ward 01 - Moniya", "Ward 02 - Ojoo"];
  for (let w = 1; w <= 4; w++) {
    const i = next++;
    wardCoIndex[w] = i;
    await send(em.registerWardCollationOfficer(signers[i].address, w));
    record(i, `Ward Collation Officer - ${wardNames[w - 1]}`, "WardCollationOfficer", Level.Ward, w, 0);
  }
  const lgaNames = ["Ibadan North", "Akinyele"];
  for (let l = 1; l <= 2; l++) {
    const i = next++;
    await send(em.registerLgaCollationOfficer(signers[i].address, l));
    record(i, `LGA Collation Officer - ${lgaNames[l - 1]}`, "LgaCollationOfficer", Level.LGA, l, 0);
  }
  const acronyms = ["PA", "DC", "LF"];
  const agent = async (level, unitId, party, label) => {
    const i = next++;
    agentIndex[`${level}-${unitId}-${party}`] = i;
    await send(em.registerPartyAgent(signers[i].address, party, level, unitId));
    record(i, `${acronyms[party - 1]} Agent - ${LEVEL_NAME[level]} ${label}`, "PartyAgent", level, unitId, party);
  };
  for (let party = 1; party <= PARTIES; party++) {
    for (let pu = 1; pu <= 8; pu++) await agent(Level.PollingUnit, pu, party, pus[pu - 1][1]);
    for (let w = 1; w <= 4; w++) await agent(Level.Ward, w, party, wardNames[w - 1]);
    for (let l = 1; l <= 2; l++) await agent(Level.LGA, l, party, lgaNames[l - 1]);
    await agent(Level.State, STATE_UNIT_ID, party, "Oyo State");
  }

  await send(em.activateElection());
  console.log("Demo election configured and activated.");

  if (PREFILL !== "none") {
    const signAll = async (level, unitId) => {
      const h = await verification.currentFiguresHash(level, unitId);
      for (let party = 1; party <= PARTIES; party++) {
        const s = signers[agentIndex[`${level}-${unitId}-${party}`]];
        await send(verification.connect(s).signResult(level, unitId, h));
      }
    };
    const uploadPu = async (pu) => {
      const f = demoFigures(pu, pus[pu - 1][3]);
      await send(upload.connect(signers[poIndex[pu]]).submitResult(pu, f, DEMO_CID));
      await signAll(Level.PollingUnit, pu);
    };
    const collate = async (level, unitId, officer) => {
      const [agg, complete] = await collation.computeAggregate(level, unitId);
      if (!complete) throw new Error(`${LEVEL_NAME[level]} ${unitId} incomplete`);
      await send(collation.connect(officer).confirmCollation(level, unitId, toFigures(agg), DEMO_CID));
      await signAll(level, unitId);
    };
    const lgaOfficer = (l) => signers[accounts.find((a) => a.category === "LgaCollationOfficer" && a.unitId === l).index];

    // "lga": LGA 2 (Akinyele) only — polling units 5-8 and wards 3-4 approved, LGA 1 left for the walkthrough
    const puRange = PREFILL === "lga" ? [5, 6, 7, 8] : [1, 2, 3, 4, 5, 6, 7, 8];
    for (const pu of puRange) await uploadPu(pu);
    for (const w of PREFILL === "lga" ? [3, 4] : [1, 2, 3, 4]) await collate(Level.Ward, w, signers[wardCoIndex[w]]);
    if (PREFILL === "lga") {
      console.log("Prefilled LGA 2 (polling units 5-8 approved, wards 3-4 approved).");
    } else {
      await send(em.closeSubmissions()); // Active -> Collation: every polling unit has reported
      for (const l of [1, 2]) await collate(Level.LGA, l, lgaOfficer(l));
      await collate(Level.State, STATE_UNIT_ID, signers[1]);
      console.log("Prefilled every level: 8 polling units, 4 wards, 2 LGAs and the state result approved (phase Collation).");
      if (PREFILL === "declared") {
        const sig = await signAudit(signers[2], audit);
        await send(audit.connect(signers[2]).verifyAndSign(sig, DEMO_CID));
        await send(audit.connect(signers[3]).declareResult());
        console.log("Audit signed by the auditor and result declared by the publisher (phase Declared).");
      } else {
        console.log("Next: act as the Independent Auditor (#2) to sign, then the Result Publisher (#3) to declare.");
      }
    }
  }

  const { chainId } = await ethers.provider.getNetwork();
  const out = path.join(__dirname, "..", "deployments", "demo-accounts.json");
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        chainId: Number(chainId),
        mnemonic: TEST_MNEMONIC,
        warning: "Publicly known test keys - never use on a real network",
        accounts,
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${out} (${accounts.length} accounts)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

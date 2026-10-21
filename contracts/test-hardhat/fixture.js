/**
 * Shared Mocha fixture mirroring test/VoteChainFixture.sol: 2 LGAs x 2 wards x 2 polling units,
 * 3 parties, one agent per party at every unit. Uses the 70 Hardhat accounts:
 *   0 admin | 1 SRO | 2 auditor | 3 publisher | 4-11 presiding officers | 12-15 ward COs |
 *   16-17 LGA COs | 18-62 party agents
 */
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
  deploySystem,
  figures,
  toFigures,
  signAudit,
  Level,
  STATE_UNIT_ID,
  DEMO_CID,
} = require("../hardhat/lib");

const PARTIES = 3;

async function deployVoteChain() {
  const signers = await ethers.getSigners();
  const [admin, sro, auditor, publisher] = signers;
  const stranger = signers[69];
  const sys = await deploySystem(admin);
  const { election, upload, verification, collation, audit } = sys;
  const em = election.connect(admin);

  await (await em.setElectionInfo("2027 Oyo State Governorship Election", "Governorship", "Oyo", 1, 0)).wait();
  await (await em.addParty("Progressive Alliance", "PA")).wait();
  await (await em.addParty("Democratic Congress", "DC")).wait();
  await (await em.addParty("Labour Front", "LF")).wait();
  await (await em.addCandidate(1, "Candidate A")).wait();
  await (await em.addCandidate(2, "Candidate B")).wait();
  await (await em.addCandidate(3, "Candidate C")).wait();

  for (let l = 1; l <= 2; l++) {
    await (await em.addLga(`LGA-${l}`)).wait();
    for (let w = 1; w <= 2; w++) {
      const wardId = (l - 1) * 2 + w;
      await (await em.addWard(l, `Ward-${l}-${w}`)).wait();
      for (let p = 1; p <= 2; p++) {
        await (await em.addPollingUnit(wardId, `OY/${l}/${w}/${p}`, `PU-${l}-${w}-${p}`, 1000)).wait();
      }
    }
  }

  const po = {};
  const wardCo = {};
  const lgaCo = {};
  let idx = 4;
  for (let pu = 1; pu <= 8; pu++) {
    po[pu] = signers[idx++];
    await (await em.registerPresidingOfficer(po[pu].address, pu)).wait();
  }
  for (let w = 1; w <= 4; w++) {
    wardCo[w] = signers[idx++];
    await (await em.registerWardCollationOfficer(wardCo[w].address, w)).wait();
  }
  for (let l = 1; l <= 2; l++) {
    lgaCo[l] = signers[idx++];
    await (await em.registerLgaCollationOfficer(lgaCo[l].address, l)).wait();
  }
  await (await em.registerStateReturningOfficer(sro.address)).wait();
  await (await em.registerAuditor(auditor.address)).wait();
  await (await em.registerResultPublisher(publisher.address)).wait();

  const agents = {}; // agents[level][unitId][party] -> signer
  const agent = async (level, unitId, party) => {
    const s = signers[idx++];
    agents[level] ??= {};
    agents[level][unitId] ??= {};
    agents[level][unitId][party] = s;
    await (await em.registerPartyAgent(s.address, party, level, unitId)).wait();
  };
  for (let party = 1; party <= PARTIES; party++) {
    for (let pu = 1; pu <= 8; pu++) await agent(Level.PollingUnit, pu, party);
    for (let w = 1; w <= 4; w++) await agent(Level.Ward, w, party);
    for (let l = 1; l <= 2; l++) await agent(Level.LGA, l, party);
    await agent(Level.State, Number(STATE_UNIT_ID), party);
  }

  const officerFor = (level, unitId) => {
    if (level === Level.PollingUnit) return po[unitId];
    if (level === Level.Ward) return wardCo[unitId];
    if (level === Level.LGA) return lgaCo[unitId];
    return sro;
  };

  const ctx = {
    ...sys,
    admin,
    sro,
    auditor,
    publisher,
    stranger,
    po,
    wardCo,
    lgaCo,
    agents,
    officerFor,
    PARTIES,
    puCount: 8,
    wardCount: 4,
    lgaCount: 2,
  };

  ctx.activate = async () => (await em.activateElection()).wait();
  ctx.figuresFor = (puId) => {
    const a = 250 + ((puId * 7) % 60);
    const b = 180 + ((puId * 11) % 50);
    const c = 60 + ((puId * 13) % 40);
    const valid = a + b + c;
    const rej = 5 + (puId % 4);
    const cast = valid + rej;
    const acc = cast + 20 + (puId % 9);
    return figures(1000, acc, cast, valid, rej, [a, b, c]);
  };
  ctx.goodFigures = () => figures(1000, 600, 580, 570, 10, [300, 200, 70]);
  ctx.submitPu = async (puId, f = ctx.figuresFor(puId)) =>
    (await upload.connect(po[puId]).submitResult(puId, f, `bafy-ec8a-${puId}`)).wait();
  ctx.signAll = async (level, unitId) => {
    const h = await verification.currentFiguresHash(level, unitId);
    for (let party = 1; party <= PARTIES; party++) {
      await (await verification.connect(agents[level][unitId][party]).signResult(level, unitId, h)).wait();
    }
  };
  ctx.approvePu = async (puId) => {
    await ctx.submitPu(puId);
    await ctx.signAll(Level.PollingUnit, puId);
  };
  ctx.collate = async (level, unitId) => {
    const [agg, complete] = await collation.computeAggregate(level, unitId);
    if (!complete) throw new Error("fixture: lower level incomplete");
    const tx = await collation.connect(officerFor(level, unitId)).confirmCollation(level, unitId, toFigures(agg), `bafy-form-${unitId}`);
    await tx.wait();
    await ctx.signAll(level, unitId);
  };
  ctx.runToStateApproved = async () => {
    for (let pu = 1; pu <= 8; pu++) await ctx.approvePu(pu);
    for (let w = 1; w <= 4; w++) await ctx.collate(Level.Ward, w);
    for (let l = 1; l <= 2; l++) await ctx.collate(Level.LGA, l);
    await ctx.collate(Level.State, Number(STATE_UNIT_ID));
  };
  ctx.auditorSignature = () => signAudit(auditor, audit);
  ctx.runToDeclared = async () => {
    await ctx.runToStateApproved();
    await (await audit.verifyAndSign(await ctx.auditorSignature(), "bafy-audit-report")).wait();
    await (await audit.connect(publisher).declareResult()).wait();
  };
  ctx.status = (level, unitId) => verification.statusOf(level, unitId);
  ctx.DEMO_CID = DEMO_CID;
  return ctx;
}

/** Same as deployVoteChain but with the election already Active. */
async function activeVoteChain() {
  const ctx = await deployVoteChain();
  await ctx.activate();
  return ctx;
}

module.exports = { deployVoteChain, activeVoteChain, loadFixture, figures, toFigures, Level, STATE_UNIT_ID };

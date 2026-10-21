const { expect } = require("chai");
const { ethers } = require("hardhat");
const { activeVoteChain, loadFixture, toFigures, Level, STATE_UNIT_ID } = require("./fixture");
const { ResultStatus, Phase, figures } = require("../hardhat/lib");

const STATE = Number(STATE_UNIT_ID);
const Field = { RegisteredVoters: 0, AccreditedVoters: 1, TotalVotesCast: 2, ValidVotes: 3, RejectedVotes: 4, CandidateVotes: 5 };

describe("CollationEngine — hierarchical aggregation (Figure 3.2)", function () {
  it("blocks ward collation until every polling unit is approved", async function () {
    const ctx = await loadFixture(activeVoteChain);
    await ctx.approvePu(1);
    await ctx.submitPu(2);
    const [agg, complete, blocking] = await ctx.collation.computeAggregate(Level.Ward, 1);
    expect(complete).to.equal(false);
    expect(blocking).to.equal(2n);
    await expect(ctx.collation.connect(ctx.wardCo[1]).confirmCollation(Level.Ward, 1, toFigures(agg), "bafy-ec8b-1"))
      .to.be.revertedWithCustomError(ctx.collation, "LowerLevelNotApproved")
      .withArgs(Level.PollingUnit, 2, ResultStatus.PendingSignatures);
  });

  it("computes the exact field-by-field sum and excludes cancelled units", async function () {
    const ctx = await loadFixture(activeVoteChain);
    await ctx.approvePu(1);
    await (await ctx.election.connect(ctx.admin).cancelPollingUnit(2, "bafy-cancel")).wait();
    const [agg, complete] = await ctx.collation.computeAggregate(Level.Ward, 1);
    expect(complete).to.equal(true);
    const f1 = ctx.figuresFor(1);
    expect(agg.validVotes).to.equal(f1.validVotes);
    expect(agg.candidateVotes[1]).to.equal(f1.candidateVotes[1]);
  });

  it("records a MismatchAlert and keeps the collation blocked when the declared total is manipulated", async function () {
    const ctx = await loadFixture(activeVoteChain);
    await ctx.approvePu(1);
    await ctx.approvePu(2);
    const [agg] = await ctx.collation.computeAggregate(Level.Ward, 1);
    const honest = toFigures(agg);
    const tampered = toFigures(agg);
    tampered.candidateVotes[0] += 50n;
    tampered.validVotes += 50n;
    tampered.totalVotesCast += 50n;
    tampered.accreditedVoters += 50n;

    await expect(ctx.collation.connect(ctx.wardCo[1]).confirmCollation(Level.Ward, 1, tampered, "bafy-ec8b-1"))
      .to.emit(ctx.collation, "MismatchAlert")
      .withArgs(Level.Ward, 1, ctx.wardCo[1].address, Field.AccreditedVoters, 0, tampered.accreditedVoters, honest.accreditedVoters, 1);
    expect(Number(await ctx.status(Level.Ward, 1))).to.equal(ResultStatus.Open);
    expect(await ctx.collation.mismatchAttemptsOf(Level.Ward, 1)).to.equal(1n);

    const [ok, field] = await ctx.collation.checkDeclared(Level.Ward, 1, tampered);
    expect(ok).to.equal(false);
    expect(Number(field)).to.equal(Field.AccreditedVoters);

    await expect(ctx.collation.connect(ctx.wardCo[1]).confirmCollation(Level.Ward, 1, honest, "bafy-ec8b-1")).to.emit(
      ctx.collation,
      "CollationConfirmed",
    );
    expect(Number(await ctx.status(Level.Ward, 1))).to.equal(ResultStatus.PendingSignatures);
  });

  it("only the responsible officer collates and no level can be skipped", async function () {
    const ctx = await loadFixture(activeVoteChain);
    for (let pu = 1; pu <= 4; pu++) await ctx.approvePu(pu);
    const [agg] = await ctx.collation.computeAggregate(Level.Ward, 1);
    await expect(ctx.collation.connect(ctx.wardCo[2]).confirmCollation(Level.Ward, 1, toFigures(agg), "cid")).to.be.revertedWithCustomError(
      ctx.collation,
      "NotCollationOfficer",
    );
    await expect(ctx.collation.connect(ctx.lgaCo[1]).confirmCollation(Level.LGA, 1, figures(0, 0, 0, 0, 0, [0, 0, 0]), "cid"))
      .to.be.revertedWithCustomError(ctx.collation, "LowerLevelNotApproved")
      .withArgs(Level.Ward, 1, ResultStatus.Open);
    await expect(ctx.collation.connect(ctx.po[1]).confirmCollation(Level.PollingUnit, 1, ctx.goodFigures(), "cid")).to.be.revertedWithCustomError(
      ctx.collation,
      "InvalidCollationLevel",
    );
  });

  it("runs the full chain to an approved state result that anyone can re-verify", async function () {
    const ctx = await loadFixture(activeVoteChain);
    await ctx.runToStateApproved();
    expect(Number(await ctx.status(Level.State, STATE))).to.equal(ResultStatus.Approved);
    const state = await ctx.collation.getFigures(Level.State, STATE);
    expect(state.registeredVoters).to.equal(8000n);
    let expectedValid = 0n;
    for (let pu = 1; pu <= 8; pu++) expectedValid += ctx.figuresFor(pu).validVotes;
    expect(state.validVotes).to.equal(expectedValid);
    for (let w = 1; w <= 4; w++) expect((await ctx.collation.verifyConsistency(Level.Ward, w))[0]).to.equal(true);
    for (let l = 1; l <= 2; l++) expect((await ctx.collation.verifyConsistency(Level.LGA, l))[0]).to.equal(true);
    expect((await ctx.collation.verifyConsistency(Level.State, STATE))[0]).to.equal(true);
  });
});

describe("AuditDeclaration — auditor gate and final declaration", function () {
  it("the publisher cannot declare before the auditor signs", async function () {
    const ctx = await loadFixture(activeVoteChain);
    await ctx.runToStateApproved();
    await expect(ctx.audit.connect(ctx.publisher).declareResult()).to.be.revertedWithCustomError(ctx.audit, "AuditNotApproved");
  });

  it("only a signature from the registered auditor is accepted", async function () {
    const ctx = await loadFixture(activeVoteChain);
    await ctx.runToStateApproved();
    const digest = await ctx.audit.auditDigest();
    const impostorSig = await ctx.stranger.signMessage(ethers.getBytes(digest));
    await expect(ctx.audit.verifyAndSign(impostorSig, "cid"))
      .to.be.revertedWithCustomError(ctx.audit, "NotAuditorSignature")
      .withArgs(ctx.stranger.address, ctx.auditor.address);
    await expect(ctx.audit.verifyAndSign("0x010203", "cid")).to.be.revertedWithCustomError(ctx.audit, "ECDSAInvalidSignatureLength");
  });

  it("records the audit, then the publisher declares and the election becomes Declared", async function () {
    const ctx = await loadFixture(activeVoteChain);
    await ctx.runToStateApproved();
    const sig = await ctx.auditorSignature();
    await expect(ctx.audit.verifyAndSign(sig, "bafy-report")).to.emit(ctx.audit, "AuditApproved");
    const a = await ctx.audit.getAudit();
    expect(a.approved).to.equal(true);
    expect(a.auditor).to.equal(ctx.auditor.address);
    expect(a.reportCid).to.equal("bafy-report");
    await expect(ctx.audit.verifyAndSign(sig, "again")).to.be.revertedWithCustomError(ctx.audit, "AlreadyAudited");

    await expect(ctx.audit.connect(ctx.admin).declareResult()).to.be.revertedWithCustomError(ctx.audit, "NotResultPublisher");
    await expect(ctx.audit.connect(ctx.publisher).declareResult()).to.emit(ctx.audit, "ResultDeclared");
    const d = await ctx.audit.getDeclaration();
    expect(d.declared).to.equal(true);
    expect(d.winnerCandidateIndex).to.equal(0n);
    expect(d.winnerPartyId).to.equal(1n);
    expect(d.tie).to.equal(false);
    expect(Number(await ctx.election.phase())).to.equal(Phase.Declared);
    expect(Number(await ctx.status(Level.State, STATE))).to.equal(ResultStatus.Declared);
    await expect(ctx.audit.connect(ctx.publisher).declareResult()).to.be.revertedWithCustomError(ctx.audit, "AlreadyDeclared");
  });

  it("pending escalations block the audit until the auditor rules", async function () {
    const ctx = await loadFixture(activeVoteChain);
    const { verification, agents, po, auditor } = ctx;
    await ctx.submitPu(1);
    await (await verification.connect(agents[Level.PollingUnit][1][1]).raiseDispute(Level.PollingUnit, 1, "r", "")).wait();
    await (await verification.connect(po[1]).resolveDispute(Level.PollingUnit, 1, 1, "cid", "n")).wait();
    await (await verification.connect(agents[Level.PollingUnit][1][1]).escalateDispute(1)).wait();
    expect((await ctx.audit.escalatedDisputes()).map(Number)).to.deep.equal([1]);
    const [ready, reason] = await ctx.audit.isReadyForAudit();
    expect(ready).to.equal(false);
    expect(reason).to.contain("not approved");
    await (await verification.connect(auditor).ruleOnEscalation(1, false, "bafy-ruling")).wait();
    const h = await verification.currentFiguresHash(Level.PollingUnit, 1);
    await (await verification.connect(agents[Level.PollingUnit][1][2]).signResult(Level.PollingUnit, 1, h)).wait();
    await (await verification.connect(agents[Level.PollingUnit][1][3]).signResult(Level.PollingUnit, 1, h)).wait();
    expect(await verification.isApproved(Level.PollingUnit, 1)).to.equal(true);
  });
});

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { activeVoteChain, loadFixture, figures, Level } = require("./fixture");
const { Rule, ResultStatus, Phase, figuresHash } = require("../hardhat/lib");

describe("ResultUpload — six validation rules (Table 3.2)", function () {
  async function expectRule(ctx, f, rule, expected, actual, puId = 1) {
    await expect(ctx.upload.connect(ctx.po[puId]).submitResult(puId, f, "cid"))
      .to.be.revertedWithCustomError(ctx.upload, "ValidationFailed")
      .withArgs(rule, expected, actual);
  }

  it("accepts consistent figures, stores them and opens the signing round", async function () {
    const ctx = await loadFixture(activeVoteChain);
    const f = ctx.goodFigures();
    await expect(ctx.upload.connect(ctx.po[1]).submitResult(1, f, "bafy-ec8a-1")).to.emit(ctx.upload, "ResultSubmitted");
    const r = await ctx.upload.getResult(1);
    expect(r.exists).to.equal(true);
    expect(r.round).to.equal(1n);
    expect(r.officer).to.equal(ctx.po[1].address);
    expect(r.figures.validVotes).to.equal(570n);
    expect(r.figures.candidateVotes[0]).to.equal(300n);
    expect(r.figuresHash).to.equal(figuresHash(Level.PollingUnit, 1, f, "bafy-ec8a-1"));
    expect(await ctx.verification.currentFiguresHash(Level.PollingUnit, 1)).to.equal(r.figuresHash);
    expect(Number(await ctx.status(Level.PollingUnit, 1))).to.equal(ResultStatus.PendingSignatures);
  });

  it("rule 1: total votes cast > accredited voters", async function () {
    const ctx = await loadFixture(activeVoteChain);
    await expectRule(ctx, figures(1000, 600, 620, 610, 10, [300, 240, 70]), Rule.CastExceedsAccredited, 600, 620);
  });

  it("rule 2: total votes cast > registered voters", async function () {
    const ctx = await loadFixture(activeVoteChain);
    await expectRule(ctx, figures(500, 700, 600, 590, 10, [300, 220, 70]), Rule.CastExceedsRegistered, 500, 600);
  });

  it("rule 3: valid + rejected != total cast", async function () {
    const ctx = await loadFixture(activeVoteChain);
    await expectRule(ctx, figures(1000, 600, 580, 565, 10, [300, 200, 65]), Rule.ValidPlusRejectedMismatch, 580, 575);
  });

  it("rule 4: sum of candidate votes != valid votes", async function () {
    const ctx = await loadFixture(activeVoteChain);
    await expectRule(ctx, figures(1000, 600, 580, 570, 10, [300, 200, 60]), Rule.CandidateSumMismatch, 570, 560);
  });

  it("rule 5: accredited voters > registered voters", async function () {
    const ctx = await loadFixture(activeVoteChain);
    await expectRule(ctx, figures(1000, 1200, 580, 570, 10, [300, 200, 70]), Rule.AccreditedExceedsRegistered, 1000, 1200);
  });

  it("register cross-check: registered voters must match INEC's PU register", async function () {
    const ctx = await loadFixture(activeVoteChain);
    await expectRule(ctx, figures(1100, 600, 580, 570, 10, [300, 200, 70]), Rule.RegisterMismatch, 1000, 1100);
  });

  it("candidate array must have one entry per candidate", async function () {
    const ctx = await loadFixture(activeVoteChain);
    await expectRule(ctx, figures(1000, 600, 580, 570, 10, [300, 270]), Rule.CandidateSumMismatch, 3, 2);
  });

  it("validateFigures view mirrors the on-chain checks for the portal", async function () {
    const ctx = await loadFixture(activeVoteChain);
    const [rule] = await ctx.upload.validateFigures(1, ctx.goodFigures());
    expect(Number(rule)).to.equal(Rule.None);
    const [bad, e, a] = await ctx.upload.validateFigures(1, figures(1000, 600, 620, 610, 10, [300, 240, 70]));
    expect(Number(bad)).to.equal(Rule.CastExceedsAccredited);
    expect(e).to.equal(600n);
    expect(a).to.equal(620n);
  });

  it("only the assigned presiding officer may upload", async function () {
    const ctx = await loadFixture(activeVoteChain);
    await expect(ctx.upload.connect(ctx.po[2]).submitResult(1, ctx.goodFigures(), "cid"))
      .to.be.revertedWithCustomError(ctx.upload, "NotPresidingOfficer")
      .withArgs(ctx.po[2].address, 1);
    await expect(ctx.upload.connect(ctx.agents[Level.PollingUnit][1][1]).submitResult(1, ctx.goodFigures(), "cid"))
      .to.be.revertedWithCustomError(ctx.upload, "NotPresidingOfficer");
  });

  it("rejects double submission, missing form CID and cancelled units", async function () {
    const ctx = await loadFixture(activeVoteChain);
    await expect(ctx.upload.connect(ctx.po[1]).submitResult(1, ctx.goodFigures(), "")).to.be.revertedWithCustomError(
      ctx.upload,
      "EmptyFormCid",
    );
    await ctx.submitPu(1);
    await expect(ctx.upload.connect(ctx.po[1]).submitResult(1, ctx.goodFigures(), "cid"))
      .to.be.revertedWithCustomError(ctx.upload, "InvalidStatus")
      .withArgs(Level.PollingUnit, 1, ResultStatus.PendingSignatures);
    await (await ctx.election.connect(ctx.admin).cancelPollingUnit(2, "bafy-cancel")).wait();
    await expect(ctx.upload.connect(ctx.po[2]).submitResult(2, ctx.goodFigures(), "cid"))
      .to.be.revertedWithCustomError(ctx.upload, "PollingUnitCancelled")
      .withArgs(2);
  });

  it("first-time submissions are only accepted in the Active phase", async function () {
    const ctx = await loadFixture(activeVoteChain);
    await (await ctx.election.connect(ctx.admin).closeSubmissions()).wait();
    await expect(ctx.upload.connect(ctx.po[1]).submitResult(1, ctx.goodFigures(), "cid"))
      .to.be.revertedWithCustomError(ctx.upload, "WrongPhase")
      .withArgs(Phase.Collation, Phase.Active);
  });

  it("resubmission is only possible while Frozen and re-runs validation", async function () {
    const ctx = await loadFixture(activeVoteChain);
    await ctx.submitPu(1, ctx.goodFigures());
    await expect(ctx.upload.connect(ctx.po[1]).resubmitResult(1, ctx.goodFigures(), "cid-2")).to.be.revertedWithCustomError(
      ctx.upload,
      "InvalidStatus",
    );
    await (await ctx.verification.connect(ctx.agents[Level.PollingUnit][1][2]).raiseDispute(Level.PollingUnit, 1, "form says 310", "bafy-evidence")).wait();
    await expect(ctx.upload.connect(ctx.po[1]).resubmitResult(1, figures(1000, 600, 580, 570, 10, [310, 200, 70]), "cid-2"))
      .to.be.revertedWithCustomError(ctx.upload, "ValidationFailed")
      .withArgs(Rule.CandidateSumMismatch, 570, 580);
    await (await ctx.upload.connect(ctx.po[1]).resubmitResult(1, figures(1000, 600, 590, 580, 10, [310, 200, 70]), "cid-2")).wait();
    const r = await ctx.upload.getResult(1);
    expect(r.round).to.equal(2n);
    expect(r.figures.candidateVotes[0]).to.equal(310n);
    expect(Number(await ctx.status(Level.PollingUnit, 1))).to.equal(ResultStatus.Resolved);
  });
});

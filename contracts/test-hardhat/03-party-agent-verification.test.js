const { expect } = require("chai");
const { activeVoteChain, loadFixture, figures, Level } = require("./fixture");
const { ResultStatus } = require("../hardhat/lib");

const PU = Level.PollingUnit;
const DisputeStatus = { Raised: 0, Resolved: 1, Accepted: 2, Escalated: 3, RuledDismissed: 4, RuledUpheld: 5 };

async function submitted() {
  const ctx = await activeVoteChain();
  await ctx.submitPu(1, ctx.goodFigures());
  return ctx;
}

describe("PartyAgentVerification — multi-party signing and dispute state machine (Figure 3.3)", function () {
  it("records a signature bound to the figures hash and needs every agent (n-of-n)", async function () {
    const ctx = await loadFixture(submitted);
    const { verification, agents } = ctx;
    const h = await verification.currentFiguresHash(PU, 1);
    await (await verification.connect(agents[PU][1][1]).signResult(PU, 1, h)).wait();
    const s = await verification.getSignature(PU, 1, 1, agents[PU][1][1].address);
    expect(s.signed).to.equal(true);
    expect(s.figuresHash).to.equal(h);
    await (await verification.connect(agents[PU][1][2]).signResult(PU, 1, h)).wait();
    expect(Number(await ctx.status(PU, 1))).to.equal(ResultStatus.PendingSignatures); // 2 of 3 is not enough
    await expect(verification.connect(agents[PU][1][3]).signResult(PU, 1, h)).to.emit(verification, "ResultApproved");
    expect(await verification.isApproved(PU, 1)).to.equal(true);
  });

  it("rejects stale hashes, double signatures and agents of other units", async function () {
    const ctx = await loadFixture(submitted);
    const { verification, agents, po } = ctx;
    const h = await verification.currentFiguresHash(PU, 1);
    const wrong = "0x" + "11".repeat(32);
    await expect(verification.connect(agents[PU][1][1]).signResult(PU, 1, wrong))
      .to.be.revertedWithCustomError(verification, "StaleFiguresHash")
      .withArgs(h, wrong);
    await (await verification.connect(agents[PU][1][1]).signResult(PU, 1, h)).wait();
    await expect(verification.connect(agents[PU][1][1]).signResult(PU, 1, h)).to.be.revertedWithCustomError(
      verification,
      "AlreadySigned",
    );
    await expect(verification.connect(agents[PU][2][1]).signResult(PU, 1, h))
      .to.be.revertedWithCustomError(verification, "NotAgentForUnit")
      .withArgs(agents[PU][2][1].address, PU, 1);
    await expect(verification.connect(po[1]).signResult(PU, 1, h)).to.be.revertedWithCustomError(verification, "NotAgentForUnit");
  });

  it("signing with an objection counts toward the threshold but is recorded permanently", async function () {
    const ctx = await loadFixture(submitted);
    const { verification, agents } = ctx;
    const h = await verification.currentFiguresHash(PU, 1);
    await expect(verification.connect(agents[PU][1][1]).signWithObjection(PU, 1, h, "Kept outside during counting"))
      .to.emit(verification, "ObjectionRecorded");
    const s = await verification.getSignature(PU, 1, 1, agents[PU][1][1].address);
    expect(s.objection).to.equal(true);
    expect(s.objectionReason).to.equal("Kept outside during counting");
    await (await verification.connect(agents[PU][1][2]).signResult(PU, 1, h)).wait();
    await (await verification.connect(agents[PU][1][3]).signResult(PU, 1, h)).wait();
    expect(Number(await ctx.status(PU, 1))).to.equal(ResultStatus.Approved);
  });

  it("a dispute freezes the result until the officer resolves and every agent re-signs", async function () {
    const ctx = await loadFixture(submitted);
    const { verification, agents, po } = ctx;
    const h = await verification.currentFiguresHash(PU, 1);
    await (await verification.connect(agents[PU][1][1]).signResult(PU, 1, h)).wait();
    await expect(verification.connect(agents[PU][1][2]).raiseDispute(PU, 1, "figures differ from form", "bafy-photo")).to.emit(
      verification,
      "DisputeRaised",
    );
    expect(Number(await ctx.status(PU, 1))).to.equal(ResultStatus.Frozen);
    await expect(verification.connect(agents[PU][1][3]).signResult(PU, 1, h))
      .to.be.revertedWithCustomError(verification, "InvalidStatus")
      .withArgs(PU, 1, ResultStatus.Frozen);

    // wrong officer cannot resolve
    await expect(verification.connect(po[2]).resolveDispute(PU, 1, 1, "cid", "note")).to.be.revertedWithCustomError(
      verification,
      "NotOfficerForUnit",
    );
    await (await verification.connect(po[1]).resolveDispute(PU, 1, 1, "bafy-resolution", "figures match the form")).wait();
    expect(Number(await ctx.status(PU, 1))).to.equal(ResultStatus.Resolved);
    const rec = await verification.getRecord(PU, 1);
    expect(rec.round).to.equal(2n);
    expect(rec.signatureCount).to.equal(0n);

    await expect(verification.connect(agents[PU][1][3]).acceptResolution(1)).to.be.revertedWithCustomError(
      verification,
      "NotDisputingAgent",
    );
    await (await verification.connect(agents[PU][1][2]).acceptResolution(1)).wait();
    expect(Number(await ctx.status(PU, 1))).to.equal(ResultStatus.PendingSignatures);
    const d = await verification.getDispute(1);
    expect(Number(d.status)).to.equal(DisputeStatus.Accepted);
    expect(Number(d.resolution.kind)).to.equal(1); // ConfirmedOriginal

    // round-1 signature does not carry over
    expect((await verification.getSignature(PU, 1, 2, agents[PU][1][1].address)).signed).to.equal(false);
    await ctx.signAll(PU, 1);
    expect(Number(await ctx.status(PU, 1))).to.equal(ResultStatus.Approved);
  });

  it("a corrected resubmission resolves the dispute with a new hash", async function () {
    const ctx = await loadFixture(submitted);
    const { verification, upload, agents, po } = ctx;
    const before = await verification.currentFiguresHash(PU, 1);
    await (await verification.connect(agents[PU][1][2]).raiseDispute(PU, 1, "A should be 310", "")).wait();
    await (await upload.connect(po[1]).resubmitResult(1, figures(1000, 600, 590, 580, 10, [310, 200, 70]), "bafy-v2")).wait();
    const after = await verification.currentFiguresHash(PU, 1);
    expect(after).to.not.equal(before);
    const d = await verification.getDispute(1);
    expect(Number(d.resolution.kind)).to.equal(2); // FiguresCorrected
    expect(d.resolution.resolvedBy).to.equal(po[1].address);
    await (await verification.connect(agents[PU][1][2]).acceptResolution(1)).wait();
    await expect(verification.connect(agents[PU][1][1]).signResult(PU, 1, before)).to.be.revertedWithCustomError(
      verification,
      "StaleFiguresHash",
    );
    await ctx.signAll(PU, 1);
    expect(Number(await ctx.status(PU, 1))).to.equal(ResultStatus.Approved);
  });

  async function escalated() {
    const ctx = await submitted();
    const { verification, agents, po } = ctx;
    await (await verification.connect(agents[PU][1][2]).raiseDispute(PU, 1, "reason", "")).wait();
    await (await verification.connect(po[1]).resolveDispute(PU, 1, 1, "cid", "confirmed")).wait();
    await (await verification.connect(agents[PU][1][2]).escalateDispute(1)).wait();
    return ctx;
  }

  it("escalation reaches the auditor; a dismissal waives the disputer's slot", async function () {
    const ctx = await loadFixture(escalated);
    const { verification, agents, auditor, admin } = ctx;
    expect(Number(await ctx.status(PU, 1))).to.equal(ResultStatus.Escalated);
    expect(await verification.pendingEscalations()).to.equal(1n);
    expect((await verification.escalatedDisputeIds()).map(Number)).to.deep.equal([1]);
    await expect(verification.connect(admin).ruleOnEscalation(1, false, "cid")).to.be.revertedWithCustomError(verification, "NotAuditor");

    await expect(verification.connect(auditor).ruleOnEscalation(1, false, "bafy-ruling")).to.emit(verification, "SignatureWaived");
    expect(Number(await ctx.status(PU, 1))).to.equal(ResultStatus.PendingSignatures);
    expect(await verification.pendingEscalations()).to.equal(0n);
    expect((await verification.getSignature(PU, 1, 2, agents[PU][1][2].address)).waived).to.equal(true);

    const h = await verification.currentFiguresHash(PU, 1);
    await (await verification.connect(agents[PU][1][1]).signResult(PU, 1, h)).wait();
    await (await verification.connect(agents[PU][1][3]).signResult(PU, 1, h)).wait();
    expect(Number(await ctx.status(PU, 1))).to.equal(ResultStatus.Approved);
  });

  it("an upheld escalation forces a corrected-figures resolution", async function () {
    const ctx = await loadFixture(escalated);
    const { verification, upload, agents, auditor, po } = ctx;
    await (await verification.connect(auditor).ruleOnEscalation(1, true, "bafy-upheld")).wait();
    expect(Number(await ctx.status(PU, 1))).to.equal(ResultStatus.Frozen);
    expect((await verification.getDispute(1)).requiresCorrection).to.equal(true);
    await expect(verification.connect(po[1]).resolveDispute(PU, 1, 1, "cid", "still correct")).to.be.revertedWithCustomError(
      verification,
      "CorrectionRequired",
    );
    await (await upload.connect(po[1]).resubmitResult(1, figures(1000, 600, 590, 580, 10, [310, 200, 70]), "bafy-v2")).wait();
    await (await verification.connect(agents[PU][1][2]).acceptResolution(1)).wait();
    await ctx.signAll(PU, 1);
    expect(Number(await ctx.status(PU, 1))).to.equal(ResultStatus.Approved);
    expect((await verification.getRecord(PU, 1)).round).to.equal(3n);
  });

  it("module-only hooks reject every external caller, including the admin", async function () {
    const ctx = await loadFixture(submitted);
    const { verification, stranger, admin } = ctx;
    const h = "0x" + "22".repeat(32);
    await expect(verification.connect(stranger).openSignatureRound(PU, 2, h)).to.be.revertedWithCustomError(verification, "NotAuthorised");
    await expect(verification.connect(admin).openSignatureRound(Level.Ward, 1, h)).to.be.revertedWithCustomError(verification, "NotAuthorised");
    await expect(verification.connect(admin).correctFigures(PU, 1, h, admin.address)).to.be.revertedWithCustomError(verification, "NotAuthorised");
  });
});

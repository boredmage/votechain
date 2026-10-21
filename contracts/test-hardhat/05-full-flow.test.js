const { expect } = require("chai");
const { activeVoteChain, loadFixture, toFigures, Level, STATE_UNIT_ID } = require("./fixture");
const { ResultStatus, Phase } = require("../hardhat/lib");

const PU = Level.PollingUnit;
const STATE = Number(STATE_UNIT_ID);

describe("Full simulated election — polling unit to state declaration", function () {
  it("runs the complete chain with a dispute, an objection, a manipulated ward total and an escalation", async function () {
    const ctx = await loadFixture(activeVoteChain);
    const { upload, verification, collation, audit, agents, po, wardCo, publisher, auditor } = ctx;

    // 1. EC8A uploads
    for (let pu = 1; pu <= 8; pu++) await ctx.submitPu(pu);

    // PU 3: dispute -> corrected resubmission -> accept -> re-sign
    await (await verification.connect(agents[PU][3][2]).raiseDispute(PU, 3, "Candidate B recorded as 191, form says 201", "bafy-photo-3")).wait();
    const corrected = ctx.figuresFor(3);
    corrected.candidateVotes[1] += 10n;
    corrected.validVotes += 10n;
    corrected.totalVotesCast += 10n;
    await (await upload.connect(po[3]).resubmitResult(3, corrected, "bafy-ec8a-3-v2")).wait();
    await (await verification.connect(agents[PU][3][2]).acceptResolution(1)).wait();
    await ctx.signAll(PU, 3);

    // PU 6: objection
    const h6 = await verification.currentFiguresHash(PU, 6);
    await (await verification.connect(agents[PU][6][3]).signWithObjection(PU, 6, h6, "Agent kept outside during counting")).wait();
    await (await verification.connect(agents[PU][6][1]).signResult(PU, 6, h6)).wait();
    await (await verification.connect(agents[PU][6][2]).signResult(PU, 6, h6)).wait();

    // PU 8: dispute -> confirmed -> escalated -> dismissed by auditor
    await (await verification.connect(agents[PU][8][1]).raiseDispute(PU, 8, "Suspected inflation", "")).wait();
    await (await verification.connect(po[8]).resolveDispute(PU, 8, 2, "bafy-res-8", "Figures match the signed EC8A")).wait();
    await (await verification.connect(agents[PU][8][1]).escalateDispute(2)).wait();
    await (await verification.connect(auditor).ruleOnEscalation(2, false, "bafy-ruling-8")).wait();
    const h8 = await verification.currentFiguresHash(PU, 8);
    await (await verification.connect(agents[PU][8][2]).signResult(PU, 8, h8)).wait();
    await (await verification.connect(agents[PU][8][3]).signResult(PU, 8, h8)).wait();

    for (const pu of [1, 2, 4, 5, 7]) await ctx.signAll(PU, pu);
    for (let pu = 1; pu <= 8; pu++) expect(await verification.isApproved(PU, pu)).to.equal(true);

    // 2. Ward 2's officer first tries to inflate candidate A
    const [agg2] = await collation.computeAggregate(Level.Ward, 2);
    const tampered = toFigures(agg2);
    tampered.candidateVotes[0] += 100n;
    tampered.validVotes += 100n;
    tampered.totalVotesCast += 100n;
    await expect(collation.connect(wardCo[2]).confirmCollation(Level.Ward, 2, tampered, "bafy-ec8b-2")).to.emit(collation, "MismatchAlert");
    expect(Number(await ctx.status(Level.Ward, 2))).to.equal(ResultStatus.Open);
    await (await collation.connect(wardCo[2]).confirmCollation(Level.Ward, 2, toFigures(agg2), "bafy-ec8b-2")).wait();
    await ctx.signAll(Level.Ward, 2);
    for (const w of [1, 3, 4]) await ctx.collate(Level.Ward, w);

    // 3-4. LGA and State
    await ctx.collate(Level.LGA, 1);
    await ctx.collate(Level.LGA, 2);
    await ctx.collate(Level.State, STATE);

    // 5. Audit gate and declaration
    await expect(audit.connect(publisher).declareResult()).to.be.revertedWithCustomError(audit, "AuditNotApproved");
    await (await audit.verifyAndSign(await ctx.auditorSignature(), "bafy-audit-report")).wait();
    await (await audit.connect(publisher).declareResult()).wait();

    // 6. Public verification
    const decl = await audit.getDeclaration();
    expect(decl.declared).to.equal(true);
    expect(Number(await ctx.election.phase())).to.equal(Phase.Declared);
    let expectedB = 0n;
    for (let pu = 1; pu <= 8; pu++) expectedB += ctx.figuresFor(pu).candidateVotes[1];
    expect(decl.figures.candidateVotes[1]).to.equal(expectedB + 10n);
    for (let w = 1; w <= 4; w++) expect((await collation.verifyConsistency(Level.Ward, w))[0]).to.equal(true);
    expect((await collation.verifyConsistency(Level.State, STATE))[0]).to.equal(true);
    expect(await verification.disputeCount()).to.equal(2n);
    expect(await collation.mismatchAttemptsOf(Level.Ward, 2)).to.equal(1n);
    expect((await verification.getSignature(PU, 6, 1, agents[PU][6][3].address)).objection).to.equal(true);
  });
});

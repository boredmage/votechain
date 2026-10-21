const { expect } = require("chai");
const { deployVoteChain, activeVoteChain, loadFixture, Level } = require("./fixture");
const { Phase } = require("../hardhat/lib");

describe("ElectionManager", function () {
  it("registers the geography, parties and candidates", async function () {
    const { election } = await loadFixture(deployVoteChain);
    expect(await election.lgaCount()).to.equal(2n);
    expect(await election.wardCount()).to.equal(4n);
    expect(await election.pollingUnitCount()).to.equal(8n);
    expect(await election.partyCount()).to.equal(3n);
    expect(await election.candidateCount()).to.equal(3n);
    const ward = await election.getWard(3);
    expect(ward.lgaId).to.equal(2n);
    expect(ward.pollingUnitIds.map(Number)).to.deep.equal([5, 6]);
    const pu = await election.getPollingUnit(5);
    expect(pu.code).to.equal("OY/2/1/1");
    expect(pu.registeredVoters).to.equal(1000n);
  });

  it("stores election information and starts in Registration", async function () {
    const { election } = await loadFixture(deployVoteChain);
    const info = await election.getElectionInfo();
    expect(info.name).to.equal("2027 Oyo State Governorship Election");
    expect(info.stateName).to.equal("Oyo");
    expect(Number(info.phase)).to.equal(Phase.Registration);
  });

  it("only the INEC admin can configure", async function () {
    const { election, stranger } = await loadFixture(deployVoteChain);
    await expect(election.connect(stranger).addLga("Ibadan North")).to.be.revertedWithCustomError(
      election,
      "AccessControlUnauthorizedAccount",
    );
  });

  it("assigns one role and one scope per address", async function () {
    const { election, po, agents, wardCo, sro, auditor, publisher } = await loadFixture(deployVoteChain);
    expect(await election.hasRole(await election.PRESIDING_OFFICER_ROLE(), po[1].address)).to.equal(true);
    expect(await election.hasRole(await election.WARD_COLLATION_OFFICER_ROLE(), wardCo[1].address)).to.equal(true);
    expect(await election.hasRole(await election.STATE_RETURNING_OFFICER_ROLE(), sro.address)).to.equal(true);
    expect(await election.hasRole(await election.AUDITOR_ROLE(), auditor.address)).to.equal(true);
    expect(await election.hasRole(await election.RESULT_PUBLISHER_ROLE(), publisher.address)).to.equal(true);

    const s = await election.stakeholderOf(agents[Level.Ward][2][3].address);
    expect(Number(s.category)).to.equal(3); // PartyAgent
    expect(Number(s.level)).to.equal(Level.Ward);
    expect(s.unitId).to.equal(2n);
    expect(s.partyId).to.equal(3n);
    expect(await election.agentCount(Level.PollingUnit, 1)).to.equal(3n);

    const [ok, party] = await election.isAgentFor(Level.LGA, 2, agents[Level.LGA][2][2].address);
    expect(ok).to.equal(true);
    expect(party).to.equal(2n);
    const [notOk] = await election.isAgentFor(Level.LGA, 1, agents[Level.LGA][2][2].address);
    expect(notOk).to.equal(false);
  });

  it("enforces separation of duties (one category per address)", async function () {
    const { election, admin, po, agents } = await loadFixture(deployVoteChain);
    await (await election.connect(admin).revokeStakeholder(agents[Level.Ward][1][1].address)).wait();
    await expect(election.connect(admin).registerPartyAgent(po[1].address, 1, Level.Ward, 1))
      .to.be.revertedWithCustomError(election, "AlreadyAssigned")
      .withArgs(po[1].address, 2); // Category.PresidingOfficer
  });

  it("allows one agent per party per unit", async function () {
    const { election, admin, stranger } = await loadFixture(deployVoteChain);
    await expect(election.connect(admin).registerPartyAgent(stranger.address, 1, Level.PollingUnit, 1))
      .to.be.revertedWithCustomError(election, "AlreadyTaken")
      .withArgs(Level.PollingUnit, 1);
  });

  it("blocks direct grantRole/revokeRole/renounceRole", async function () {
    const { election, admin, stranger, agents } = await loadFixture(deployVoteChain);
    const role = await election.PARTY_AGENT_ROLE();
    await expect(election.connect(admin).grantRole(role, stranger.address)).to.be.revertedWithCustomError(
      election,
      "UseRegistrationFunctions",
    );
    const agent = agents[Level.PollingUnit][1][1];
    await expect(election.connect(agent).renounceRole(role, agent.address)).to.be.revertedWithCustomError(
      election,
      "RenounceDisabled",
    );
  });

  it("freezes registration once the election is Active", async function () {
    const { election, admin, stranger } = await loadFixture(activeVoteChain);
    expect(Number(await election.phase())).to.equal(Phase.Active);
    await expect(election.connect(admin).addLga("Late LGA"))
      .to.be.revertedWithCustomError(election, "WrongPhase")
      .withArgs(Phase.Active, Phase.Registration);
    await expect(election.connect(admin).registerPartyAgent(stranger.address, 1, Level.Ward, 1)).to.be.revertedWithCustomError(
      election,
      "WrongPhase",
    );
    await (await election.connect(admin).closeSubmissions()).wait();
    expect(Number(await election.phase())).to.equal(Phase.Collation);
    await expect(election.connect(admin).markDeclared()).to.be.revertedWithCustomError(election, "NotAuthorised");
  });

  it("can cancel a polling unit only while it has no figures", async function () {
    const { election, admin, submitPu } = await loadFixture(activeVoteChain);
    await (await election.connect(admin).cancelPollingUnit(2, "bafy-cancel")).wait();
    expect(await election.isPollingUnitCancelled(2)).to.equal(true);
    await submitPu(1);
    await expect(election.connect(admin).cancelPollingUnit(1, "late"))
      .to.be.revertedWithCustomError(election, "PollingUnitHasResult")
      .withArgs(1);
  });
});

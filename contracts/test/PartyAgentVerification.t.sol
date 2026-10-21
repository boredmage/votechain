// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { VoteChainFixture } from "./VoteChainFixture.sol";
import { VoteChainTypes as T } from "../src/VoteChainTypes.sol";
import { PartyAgentVerification as PAV } from "../src/PartyAgentVerification.sol";

contract PartyAgentVerificationTest is VoteChainFixture {
    T.Level constant PU = T.Level.PollingUnit;

    function setUp() public override {
        super.setUp();
        activate();
        submitPu(1, goodFigures());
    }

    function hash1() internal view returns (bytes32) {
        return verification.currentFiguresHash(PU, 1);
    }

    // ------------------------------------------------------------------
    // Signing & n-of-n threshold
    // ------------------------------------------------------------------
    function test_signatureIsRecordedAndBoundToFigures() public {
        bytes32 h = hash1();
        address a1 = agentOf[0][1][1];
        vm.prank(a1);
        verification.signResult(PU, 1, h);

        PAV.SignatureRecord memory s = verification.getSignature(PU, 1, 1, a1);
        assertTrue(s.signed);
        assertFalse(s.objection);
        assertEq(s.figuresHash, h);
        assertEq(s.blockNumber, block.number);
        assertEq(verification.getRecord(PU, 1).signatureCount, 1);
        assertStatus(PU, 1, T.ResultStatus.PendingSignatures); // 1 of 3
    }

    function test_approvalRequiresEveryRegisteredAgent() public {
        bytes32 h = hash1();
        vm.prank(agentOf[0][1][1]);
        verification.signResult(PU, 1, h);
        vm.prank(agentOf[0][1][2]);
        verification.signResult(PU, 1, h);
        assertStatus(PU, 1, T.ResultStatus.PendingSignatures); // 2 of 3 is NOT enough (no majority rule)

        vm.prank(agentOf[0][1][3]);
        vm.expectEmit(true, true, false, true);
        emit PAV.ResultApproved(PU, 1, 1, 3, uint64(block.timestamp));
        verification.signResult(PU, 1, h);
        assertStatus(PU, 1, T.ResultStatus.Approved);
        assertTrue(verification.isApproved(PU, 1));
    }

    function test_staleHashRejected() public {
        bytes32 h = hash1();
        bytes32 wrong = keccak256("tampered");
        vm.prank(agentOf[0][1][1]);
        vm.expectRevert(abi.encodeWithSelector(PAV.StaleFiguresHash.selector, h, wrong));
        verification.signResult(PU, 1, wrong);
    }

    function test_cannotSignTwice() public {
        bytes32 h = hash1();
        vm.startPrank(agentOf[0][1][1]);
        verification.signResult(PU, 1, h);
        vm.expectRevert(abi.encodeWithSelector(PAV.AlreadySigned.selector, agentOf[0][1][1], 1));
        verification.signResult(PU, 1, h);
        vm.stopPrank();
    }

    function test_onlyAgentsOfThatUnitAndLevel() public {
        bytes32 h = hash1();
        // agent of another polling unit
        vm.prank(agentOf[0][2][1]);
        vm.expectRevert(abi.encodeWithSelector(PAV.NotAgentForUnit.selector, agentOf[0][2][1], PU, 1));
        verification.signResult(PU, 1, h);
        // ward-level agent of the ward containing PU 1
        vm.prank(agentOf[1][1][1]);
        vm.expectRevert(abi.encodeWithSelector(PAV.NotAgentForUnit.selector, agentOf[1][1][1], PU, 1));
        verification.signResult(PU, 1, h);
        // presiding officer cannot sign as an agent
        vm.prank(poOf[1]);
        vm.expectRevert(abi.encodeWithSelector(PAV.NotAgentForUnit.selector, poOf[1], PU, 1));
        verification.signResult(PU, 1, h);
    }

    function test_cannotSignBeforeFiguresExist() public {
        vm.prank(agentOf[0][2][1]);
        vm.expectRevert(abi.encodeWithSelector(T.InvalidStatus.selector, PU, 2, T.ResultStatus.Open));
        verification.signResult(PU, 2, bytes32(0));
    }

    function test_signWithObjectionCountsButIsRecorded() public {
        bytes32 h = hash1();
        vm.prank(agentOf[0][1][1]);
        vm.expectEmit(true, true, false, true);
        emit PAV.ObjectionRecorded(PU, 1, 1, agentOf[0][1][1], 1, "Agent was denied a seat at the table");
        verification.signWithObjection(PU, 1, h, "Agent was denied a seat at the table");
        PAV.SignatureRecord memory s = verification.getSignature(PU, 1, 1, agentOf[0][1][1]);
        assertTrue(s.signed && s.objection);
        assertEq(s.objectionReason, "Agent was denied a seat at the table");

        vm.prank(agentOf[0][1][2]);
        verification.signResult(PU, 1, h);
        vm.prank(agentOf[0][1][3]);
        verification.signResult(PU, 1, h);
        assertStatus(PU, 1, T.ResultStatus.Approved); // collation continues, objection stays on-chain
    }

    function test_objectionRequiresReason() public {
        bytes32 h = hash1();
        vm.prank(agentOf[0][1][1]);
        vm.expectRevert(PAV.EmptyReason.selector);
        verification.signWithObjection(PU, 1, h, "");
    }

    function test_signingProgressView() public {
        bytes32 h = hash1();
        vm.prank(agentOf[0][1][2]);
        verification.signResult(PU, 1, h);
        (address[] memory agents, bool[] memory signed,,) = verification.signingProgress(PU, 1);
        assertEq(agents.length, 3);
        uint256 count;
        for (uint256 i = 0; i < agents.length; i++) {
            if (signed[i]) {
                count++;
                assertEq(agents[i], agentOf[0][1][2]);
            }
        }
        assertEq(count, 1);
        assertEq(verification.requiredSignatures(PU, 1), 3);
    }

    // ------------------------------------------------------------------
    // Dispute -> Frozen
    // ------------------------------------------------------------------
    function test_disputeFreezesResultAndRecordsDetails() public {
        bytes32 h = hash1();
        address a2 = agentOf[0][1][2];
        vm.prank(a2);
        vm.expectEmit(true, true, true, true);
        emit PAV.DisputeRaised(1, PU, 1, 1, a2, 2, "EC8A shows 310 for A", "bafy-photo");
        uint256 id = verification.raiseDispute(PU, 1, "EC8A shows 310 for A", "bafy-photo");
        assertEq(id, 1);
        assertStatus(PU, 1, T.ResultStatus.Frozen);

        PAV.Dispute memory d = verification.getDispute(1);
        assertEq(d.agent, a2);
        assertEq(d.partyId, 2);
        assertEq(d.round, 1);
        assertEq(d.disputedFiguresHash, h);
        assertEq(uint8(d.status), uint8(T.DisputeStatus.Raised));
        assertEq(verification.getRecord(PU, 1).activeDisputeId, 1);
        assertEq(verification.disputeIdsOf(PU, 1).length, 1);

        // frozen: nobody can sign
        vm.prank(agentOf[0][1][1]);
        vm.expectRevert(abi.encodeWithSelector(T.InvalidStatus.selector, PU, 1, T.ResultStatus.Frozen));
        verification.signResult(PU, 1, h);
        // and a second dispute cannot be opened concurrently
        vm.prank(agentOf[0][1][3]);
        vm.expectRevert(abi.encodeWithSelector(T.InvalidStatus.selector, PU, 1, T.ResultStatus.Frozen));
        verification.raiseDispute(PU, 1, "me too", "");
    }

    function test_disputeNeedsReasonAndUnsignedAgent() public {
        bytes32 h = hash1();
        vm.prank(agentOf[0][1][1]);
        vm.expectRevert(PAV.EmptyReason.selector);
        verification.raiseDispute(PU, 1, "", "");

        vm.startPrank(agentOf[0][1][1]);
        verification.signResult(PU, 1, h);
        vm.expectRevert(abi.encodeWithSelector(PAV.CannotDisputeAfterSigning.selector, agentOf[0][1][1]));
        verification.raiseDispute(PU, 1, "changed my mind", "");
        vm.stopPrank();
    }

    function test_nonAgentCannotDispute() public {
        vm.prank(poOf[1]);
        vm.expectRevert(abi.encodeWithSelector(PAV.NotAgentForUnit.selector, poOf[1], PU, 1));
        verification.raiseDispute(PU, 1, "x", "");
    }

    // ------------------------------------------------------------------
    // Resolution: officer confirms original -> agent accepts -> everyone re-signs
    // ------------------------------------------------------------------
    function test_confirmOriginalResolutionThenAcceptRestartsSigning() public {
        bytes32 h = hash1();
        // one agent signs first, then another disputes
        vm.prank(agentOf[0][1][1]);
        verification.signResult(PU, 1, h);
        vm.prank(agentOf[0][1][2]);
        verification.raiseDispute(PU, 1, "figures differ from form", "bafy-photo");

        // only the responsible officer may resolve
        vm.prank(poOf[2]);
        vm.expectRevert(abi.encodeWithSelector(PAV.NotOfficerForUnit.selector, poOf[2], PU, 1));
        verification.resolveDispute(PU, 1, 1, "bafy-res", "note");
        vm.prank(agentOf[0][1][2]);
        vm.expectRevert(abi.encodeWithSelector(PAV.NotOfficerForUnit.selector, agentOf[0][1][2], PU, 1));
        verification.resolveDispute(PU, 1, 1, "bafy-res", "note");

        vm.prank(poOf[1]);
        vm.expectEmit(true, true, false, true);
        emit PAV.DisputeResolved(1, T.ResolutionType.ConfirmedOriginal, poOf[1], "bafy-resolution", 2);
        verification.resolveDispute(PU, 1, 1, "bafy-resolution", "Figures match the physical EC8A form");
        assertStatus(PU, 1, T.ResultStatus.Resolved);
        PAV.ResultRecord memory r = verification.getRecord(PU, 1);
        assertEq(r.round, 2);
        assertEq(r.signatureCount, 0);
        assertEq(r.figuresHash, h); // same figures

        // still frozen for signing until the agent accepts
        vm.prank(agentOf[0][1][3]);
        vm.expectRevert(abi.encodeWithSelector(T.InvalidStatus.selector, PU, 1, T.ResultStatus.Resolved));
        verification.signResult(PU, 1, h);

        // only the disputing agent can accept
        vm.prank(agentOf[0][1][3]);
        vm.expectRevert(abi.encodeWithSelector(PAV.NotDisputingAgent.selector, agentOf[0][1][3], 1));
        verification.acceptResolution(1);
        vm.prank(agentOf[0][1][2]);
        verification.acceptResolution(1);
        assertStatus(PU, 1, T.ResultStatus.PendingSignatures);
        assertEq(verification.getRecord(PU, 1).activeDisputeId, 0);
        assertEq(uint8(verification.getDispute(1).status), uint8(T.DisputeStatus.Accepted));

        // agent 1's round-1 signature does not carry over: all three must sign round 2
        assertFalse(verification.getSignature(PU, 1, 2, agentOf[0][1][1]).signed);
        signAll(PU, 1);
        assertStatus(PU, 1, T.ResultStatus.Approved);
        assertEq(verification.signersOf(PU, 1, 2).length, 3);
    }

    // ------------------------------------------------------------------
    // Resolution by correction (presiding officer resubmits)
    // ------------------------------------------------------------------
    function test_correctionResolutionOpensNewRoundWithNewHash() public {
        vm.prank(agentOf[0][1][2]);
        verification.raiseDispute(PU, 1, "candidate A should be 310", "bafy-photo");
        bytes32 before = hash1();

        vm.prank(poOf[1]);
        upload.resubmitResult(1, fig(1000, 600, 590, 580, 10, cv3(310, 200, 70)), "bafy-ec8a-1-v2");
        assertStatus(PU, 1, T.ResultStatus.Resolved);
        PAV.Dispute memory d = verification.getDispute(1);
        assertEq(uint8(d.status), uint8(T.DisputeStatus.Resolved));
        assertEq(uint8(d.resolution.kind), uint8(T.ResolutionType.FiguresCorrected));
        assertEq(d.resolution.resolvedBy, poOf[1]);
        bytes32 newHash = hash1();
        assertTrue(newHash != before);
        assertEq(verification.getRecord(PU, 1).round, 2);

        vm.prank(agentOf[0][1][2]);
        verification.acceptResolution(1);
        // signing the OLD hash fails; the new hash works
        vm.prank(agentOf[0][1][1]);
        vm.expectRevert(abi.encodeWithSelector(PAV.StaleFiguresHash.selector, newHash, before));
        verification.signResult(PU, 1, before);
        signAll(PU, 1);
        assertStatus(PU, 1, T.ResultStatus.Approved);
    }

    function test_officerCannotResolveWithoutActiveDisputeOrWrongId() public {
        vm.prank(poOf[1]);
        vm.expectRevert(
            abi.encodeWithSelector(T.InvalidStatus.selector, PU, 1, T.ResultStatus.PendingSignatures)
        );
        verification.resolveDispute(PU, 1, 1, "cid", "note");

        vm.prank(agentOf[0][1][2]);
        verification.raiseDispute(PU, 1, "reason", "");
        vm.prank(poOf[1]);
        vm.expectRevert(abi.encodeWithSelector(PAV.WrongDispute.selector, 1, 7));
        verification.resolveDispute(PU, 1, 7, "cid", "note");
    }

    // ------------------------------------------------------------------
    // Escalation -> auditor ruling
    // ------------------------------------------------------------------
    function _escalated() internal returns (address disputer) {
        disputer = agentOf[0][1][2];
        vm.prank(disputer);
        verification.raiseDispute(PU, 1, "figures differ from form", "bafy-photo");
        vm.prank(poOf[1]);
        verification.resolveDispute(PU, 1, 1, "bafy-resolution", "Original figures confirmed");
        vm.prank(disputer);
        vm.expectEmit(true, true, false, true);
        emit PAV.DisputeEscalated(1, disputer);
        verification.escalateDispute(1);
        assertStatus(PU, 1, T.ResultStatus.Escalated);
        assertEq(verification.pendingEscalations(), 1);
        uint256[] memory ids = verification.escalatedDisputeIds();
        assertEq(ids.length, 1);
        assertEq(ids[0], 1);
    }

    function test_onlyAuditorRules() public {
        _escalated();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(PAV.NotAuditor.selector, admin));
        verification.ruleOnEscalation(1, false, "cid");
        vm.prank(poOf[1]);
        vm.expectRevert(abi.encodeWithSelector(PAV.NotAuditor.selector, poOf[1]));
        verification.ruleOnEscalation(1, true, "cid");
    }

    function test_auditorDismissesEscalation_waivesDisputerAndContinues() public {
        bytes32 h = hash1();
        address disputer = _escalated();
        vm.prank(auditor);
        vm.expectEmit(true, true, false, true);
        emit PAV.SignatureWaived(PU, 1, 2, disputer, 1);
        verification.ruleOnEscalation(1, false, "bafy-ruling");

        assertStatus(PU, 1, T.ResultStatus.PendingSignatures);
        assertEq(verification.pendingEscalations(), 0);
        PAV.Dispute memory d = verification.getDispute(1);
        assertEq(uint8(d.status), uint8(T.DisputeStatus.RuledDismissed));
        assertFalse(d.ruling.upheld);
        assertEq(d.ruling.documentCid, "bafy-ruling");
        assertTrue(verification.getSignature(PU, 1, 2, disputer).waived);
        assertEq(verification.getRecord(PU, 1).signatureCount, 1);

        // remaining two agents complete the round -> Approved without the disputer's signature
        vm.prank(agentOf[0][1][1]);
        verification.signResult(PU, 1, h);
        vm.prank(agentOf[0][1][3]);
        verification.signResult(PU, 1, h);
        assertStatus(PU, 1, T.ResultStatus.Approved);
    }

    function test_waivedAgentMayStillSignWithoutDoubleCounting() public {
        bytes32 h = hash1();
        address disputer = _escalated();
        vm.prank(auditor);
        verification.ruleOnEscalation(1, false, "bafy-ruling");
        vm.prank(disputer);
        verification.signWithObjection(PU, 1, h, "signing under protest");
        assertEq(verification.getRecord(PU, 1).signatureCount, 1); // still 1, not 2
        assertStatus(PU, 1, T.ResultStatus.PendingSignatures);
    }

    function test_auditorUpholdsEscalation_requiresCorrection() public {
        _escalated();
        vm.prank(auditor);
        verification.ruleOnEscalation(1, true, "bafy-ruling-upheld");
        assertStatus(PU, 1, T.ResultStatus.Frozen);
        PAV.Dispute memory d = verification.getDispute(1);
        assertEq(uint8(d.status), uint8(T.DisputeStatus.RuledUpheld));
        assertTrue(d.requiresCorrection);

        // officer may no longer simply confirm the original figures
        vm.prank(poOf[1]);
        vm.expectRevert(abi.encodeWithSelector(PAV.CorrectionRequired.selector, 1));
        verification.resolveDispute(PU, 1, 1, "cid", "still correct");

        // a corrected resubmission resolves it
        vm.prank(poOf[1]);
        upload.resubmitResult(1, fig(1000, 600, 590, 580, 10, cv3(310, 200, 70)), "bafy-ec8a-1-v2");
        assertStatus(PU, 1, T.ResultStatus.Resolved);
        assertEq(verification.getRecord(PU, 1).round, 3);
        vm.prank(agentOf[0][1][2]);
        verification.acceptResolution(1);
        signAll(PU, 1);
        assertStatus(PU, 1, T.ResultStatus.Approved);
    }

    function test_escalationGuards() public {
        vm.prank(agentOf[0][1][2]);
        verification.raiseDispute(PU, 1, "r", "");
        // cannot escalate before the officer has resolved
        vm.prank(agentOf[0][1][2]);
        vm.expectRevert(abi.encodeWithSelector(PAV.InvalidDisputeStatus.selector, 1, T.DisputeStatus.Raised));
        verification.escalateDispute(1);
        // unknown dispute
        vm.prank(agentOf[0][1][2]);
        vm.expectRevert(abi.encodeWithSelector(PAV.UnknownDispute.selector, 42));
        verification.acceptResolution(42);
        // auditor cannot rule on a non-escalated dispute
        vm.prank(auditor);
        vm.expectRevert(abi.encodeWithSelector(PAV.InvalidDisputeStatus.selector, 1, T.DisputeStatus.Raised));
        verification.ruleOnEscalation(1, false, "");
    }

    // ------------------------------------------------------------------
    // Module-only hooks
    // ------------------------------------------------------------------
    function test_moduleHooksRejectExternalCallers() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(T.NotAuthorised.selector, stranger));
        verification.openSignatureRound(PU, 2, keccak256("x"));
        vm.expectRevert(abi.encodeWithSelector(T.NotAuthorised.selector, stranger));
        verification.correctFigures(PU, 1, keccak256("x"), stranger);
        vm.expectRevert(abi.encodeWithSelector(T.NotAuthorised.selector, stranger));
        verification.markDeclared(T.Level.State, T.STATE_UNIT_ID);
        vm.stopPrank();
        // even the INEC admin cannot forge a signing round
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(T.NotAuthorised.selector, admin));
        verification.openSignatureRound(T.Level.Ward, 1, keccak256("x"));
    }

    function test_actionsBlockedOutsideOperationalPhases() public {
        bytes32 h = hash1();
        vm.prank(admin);
        election.closeSubmissions();
        // Collation phase still allows signing; Registration/Declared do not (covered in AuditDeclaration tests)
        vm.prank(agentOf[0][1][1]);
        verification.signResult(PU, 1, h);
        assertEq(verification.getRecord(PU, 1).signatureCount, 1);
    }
}

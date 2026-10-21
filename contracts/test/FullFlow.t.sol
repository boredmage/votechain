// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { VoteChainFixture } from "./VoteChainFixture.sol";
import { VoteChainTypes as T } from "../src/VoteChainTypes.sol";
import { CollationEngine } from "../src/CollationEngine.sol";
import { AuditDeclaration } from "../src/AuditDeclaration.sol";
import { PartyAgentVerification as PAV } from "../src/PartyAgentVerification.sol";

/// @notice End-to-end simulated election: 2 LGAs x 2 wards x 2 polling units, 3 parties.
///         Exercises the complete four-level chain including a dispute with correction, a
///         non-blocking objection, a manipulated ward total, an escalation ruled by the auditor,
///         the auditor's signature gate and the final declaration – then re-verifies the chain
///         the way a member of the public would.
contract FullFlowTest is VoteChainFixture {
    function setUp() public override {
        super.setUp();
        activate();
    }

    function test_simulatedOyoElectionEndToEnd() public {
        // ---------------------------------------------------------------
        // 1. Polling-unit level (EC8A)
        // ---------------------------------------------------------------
        for (uint256 pu = 1; pu <= puCount; pu++) {
            submitPu(pu);
        }

        // PU 3: party 2's agent disputes; presiding officer corrects the figures; all re-sign.
        vm.prank(agentOf[0][3][2]);
        uint256 d1 = verification.raiseDispute(
            T.Level.PollingUnit, 3, "Candidate B recorded as 191, form says 201", "bafy-photo-3"
        );
        assertStatus(T.Level.PollingUnit, 3, T.ResultStatus.Frozen);
        T.Figures memory corrected = figuresFor(3);
        corrected.candidateVotes[1] += 10;
        corrected.validVotes += 10;
        corrected.totalVotesCast += 10;
        vm.prank(poOf[3]);
        upload.resubmitResult(3, corrected, "bafy-ec8a-3-v2");
        vm.prank(agentOf[0][3][2]);
        verification.acceptResolution(d1);
        signAll(T.Level.PollingUnit, 3);
        assertStatus(T.Level.PollingUnit, 3, T.ResultStatus.Approved);

        // PU 6: party 3's agent signs under objection (figures tally; agent complains about access).
        bytes32 h6 = verification.currentFiguresHash(T.Level.PollingUnit, 6);
        vm.prank(agentOf[0][6][3]);
        verification.signWithObjection(T.Level.PollingUnit, 6, h6, "Agent was kept outside during counting");
        vm.prank(agentOf[0][6][1]);
        verification.signResult(T.Level.PollingUnit, 6, h6);
        vm.prank(agentOf[0][6][2]);
        verification.signResult(T.Level.PollingUnit, 6, h6);
        assertStatus(T.Level.PollingUnit, 6, T.ResultStatus.Approved);

        // PU 8: dispute -> officer confirms original -> agent escalates -> auditor dismisses.
        vm.prank(agentOf[0][8][1]);
        uint256 d2 = verification.raiseDispute(T.Level.PollingUnit, 8, "Suspected inflation", "");
        vm.prank(poOf[8]);
        verification.resolveDispute(T.Level.PollingUnit, 8, d2, "bafy-res-8", "Figures match the signed EC8A");
        vm.prank(agentOf[0][8][1]);
        verification.escalateDispute(d2);
        assertEq(verification.pendingEscalations(), 1);
        vm.prank(auditor);
        verification.ruleOnEscalation(d2, false, "bafy-ruling-8");
        bytes32 h8 = verification.currentFiguresHash(T.Level.PollingUnit, 8);
        vm.prank(agentOf[0][8][2]);
        verification.signResult(T.Level.PollingUnit, 8, h8);
        vm.prank(agentOf[0][8][3]);
        verification.signResult(T.Level.PollingUnit, 8, h8);
        assertStatus(T.Level.PollingUnit, 8, T.ResultStatus.Approved);

        // remaining units: all agents sign
        uint256[5] memory plain = [uint256(1), 2, 4, 5, 7];
        for (uint256 i = 0; i < plain.length; i++) {
            signAll(T.Level.PollingUnit, plain[i]);
        }
        for (uint256 pu = 1; pu <= puCount; pu++) {
            assertTrue(verification.isApproved(T.Level.PollingUnit, pu));
        }

        // ---------------------------------------------------------------
        // 2. Ward level (EC8B) – ward 2's officer first tries to inflate candidate A
        // ---------------------------------------------------------------
        (T.Figures memory ward2,,) = collation.computeAggregate(T.Level.Ward, 2);
        (T.Figures memory tampered,,) = collation.computeAggregate(T.Level.Ward, 2);
        tampered.candidateVotes[0] += 100;
        tampered.validVotes += 100;
        tampered.totalVotesCast += 100;
        vm.prank(wardCoOf[2]);
        assertFalse(collation.confirmCollation(T.Level.Ward, 2, tampered, "bafy-ec8b-2"));
        assertEq(collation.mismatchAttemptsOf(T.Level.Ward, 2), 1);
        assertStatus(T.Level.Ward, 2, T.ResultStatus.Open);

        vm.prank(wardCoOf[2]);
        assertTrue(collation.confirmCollation(T.Level.Ward, 2, ward2, "bafy-ec8b-2"));
        signAll(T.Level.Ward, 2);
        collate(T.Level.Ward, 1);
        collate(T.Level.Ward, 3);
        collate(T.Level.Ward, 4);

        // ---------------------------------------------------------------
        // 3. LGA level (EC8C) and 4. State level (EC8D)
        // ---------------------------------------------------------------
        collate(T.Level.LGA, 1);
        collate(T.Level.LGA, 2);
        collate(T.Level.State, T.STATE_UNIT_ID);
        assertStatus(T.Level.State, T.STATE_UNIT_ID, T.ResultStatus.Approved);

        // ---------------------------------------------------------------
        // 5. Independent audit and declaration
        // ---------------------------------------------------------------
        vm.prank(publisher);
        vm.expectRevert(AuditDeclaration.AuditNotApproved.selector);
        audit.declareResult();

        (bool ready,) = audit.isReadyForAudit();
        assertTrue(ready);
        audit.verifyAndSign(auditorSignature(), "bafy-audit-report");
        vm.prank(publisher);
        audit.declareResult();

        // ---------------------------------------------------------------
        // 6. Public verification of the whole chain
        // ---------------------------------------------------------------
        AuditDeclaration.Declaration memory decl = audit.getDeclaration();
        assertTrue(decl.declared);
        assertEq(uint8(election.phase()), uint8(T.Phase.Declared));

        // state figures == sum of the (corrected) polling-unit figures
        T.Figures memory expected = T.emptyFigures(3);
        for (uint256 pu = 1; pu <= puCount; pu++) {
            expected = sum(expected, upload.getFigures(pu));
        }
        assertEq(decl.figures.validVotes, expected.validVotes);
        assertEq(decl.figures.candidateVotes[1], expected.candidateVotes[1]);
        assertEq(
            decl.figures.candidateVotes[1], _sumFor(1) + 10, "corrected PU 3 figures propagated to state"
        );

        // every collation still recomputes correctly from the level below
        for (uint256 w = 1; w <= wardCount; w++) {
            (bool ok,,,,) = collation.verifyConsistency(T.Level.Ward, w);
            assertTrue(ok);
        }
        for (uint256 l = 1; l <= lgaCount; l++) {
            (bool ok,,,,) = collation.verifyConsistency(T.Level.LGA, l);
            assertTrue(ok);
        }
        (bool okState,,,,) = collation.verifyConsistency(T.Level.State, T.STATE_UNIT_ID);
        assertTrue(okState);

        // the audit trail is complete: 2 disputes, 1 objection, 1 mismatch attempt, 1 ruling
        assertEq(verification.disputeCount(), 2);
        assertEq(uint8(verification.getDispute(d1).status), uint8(T.DisputeStatus.Accepted));
        assertEq(uint8(verification.getDispute(d2).status), uint8(T.DisputeStatus.RuledDismissed));
        assertTrue(verification.getSignature(T.Level.PollingUnit, 6, 1, agentOf[0][6][3]).objection);
        assertTrue(verification.getSignature(T.Level.PollingUnit, 8, 2, agentOf[0][8][1]).waived);
        assertEq(collation.mismatchAttemptsOf(T.Level.Ward, 2), 1);
        assertEq(audit.getAudit().auditor, auditor);
    }

    function _sumFor(uint256 candidate) internal view returns (uint256 total) {
        for (uint256 pu = 1; pu <= puCount; pu++) {
            total += figuresFor(pu).candidateVotes[candidate];
        }
    }
}

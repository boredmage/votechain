// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { VoteChainFixture } from "./VoteChainFixture.sol";
import { VoteChainTypes as T } from "../src/VoteChainTypes.sol";
import { CollationEngine } from "../src/CollationEngine.sol";
import { PartyAgentVerification as PAV } from "../src/PartyAgentVerification.sol";

contract CollationEngineTest is VoteChainFixture {
    function setUp() public override {
        super.setUp();
        activate();
    }

    // ------------------------------------------------------------------
    // Aggregation
    // ------------------------------------------------------------------
    function test_wardAggregateBlockedUntilEveryPollingUnitApproved() public {
        approvePu(1);
        submitPu(2); // pending signatures only
        (T.Figures memory agg, bool complete, uint256 blocking) = collation.computeAggregate(T.Level.Ward, 1);
        assertFalse(complete);
        assertEq(blocking, 2);
        assertEq(agg.validVotes, figuresFor(1).validVotes); // partial sum reported for the UI

        vm.prank(wardCoOf[1]);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollationEngine.LowerLevelNotApproved.selector,
                T.Level.PollingUnit,
                2,
                T.ResultStatus.PendingSignatures
            )
        );
        collation.confirmCollation(T.Level.Ward, 1, agg, "bafy-ec8b-1");
    }

    function test_frozenPollingUnitBlocksWard() public {
        approvePu(1);
        submitPu(2);
        vm.prank(agentOf[0][2][1]);
        verification.raiseDispute(T.Level.PollingUnit, 2, "dispute", "");
        (, bool complete, uint256 blocking) = collation.computeAggregate(T.Level.Ward, 1);
        assertFalse(complete);
        assertEq(blocking, 2);
    }

    function test_wardAggregateIsExactSumOfPollingUnits() public {
        approvePu(1);
        approvePu(2);
        (T.Figures memory agg, bool complete,) = collation.computeAggregate(T.Level.Ward, 1);
        assertTrue(complete);
        T.Figures memory expected = sum(figuresFor(1), figuresFor(2));
        assertEq(agg.registeredVoters, expected.registeredVoters);
        assertEq(agg.accreditedVoters, expected.accreditedVoters);
        assertEq(agg.totalVotesCast, expected.totalVotesCast);
        assertEq(agg.validVotes, expected.validVotes);
        assertEq(agg.rejectedVotes, expected.rejectedVotes);
        for (uint256 i = 0; i < 3; i++) {
            assertEq(agg.candidateVotes[i], expected.candidateVotes[i]);
        }
    }

    function test_cancelledPollingUnitIsExcluded() public {
        vm.prank(admin);
        election.cancelPollingUnit(2, "bafy-cancel");
        approvePu(1);
        (T.Figures memory agg, bool complete,) = collation.computeAggregate(T.Level.Ward, 1);
        assertTrue(complete);
        assertEq(agg.validVotes, figuresFor(1).validVotes);
    }

    // ------------------------------------------------------------------
    // Confirmation
    // ------------------------------------------------------------------
    function test_honestConfirmationOpensWardSigning() public {
        approvePu(1);
        approvePu(2);
        (T.Figures memory agg,,) = collation.computeAggregate(T.Level.Ward, 1);
        vm.prank(wardCoOf[1]);
        vm.expectEmit(true, true, true, false);
        emit CollationEngine.CollationConfirmed(T.Level.Ward, 1, 1, wardCoOf[1], bytes32(0), "", 0);
        bool ok = collation.confirmCollation(T.Level.Ward, 1, agg, "bafy-ec8b-1");
        assertTrue(ok);

        CollationEngine.CollationRecord memory rec = collation.getCollation(T.Level.Ward, 1);
        assertTrue(rec.exists);
        assertEq(rec.round, 1);
        assertEq(rec.officer, wardCoOf[1]);
        assertEq(rec.formCid, "bafy-ec8b-1");
        assertEq(rec.figuresHash, T.figuresHash(T.Level.Ward, 1, agg, "bafy-ec8b-1"));
        assertStatus(T.Level.Ward, 1, T.ResultStatus.PendingSignatures);
        assertEq(rec.mismatchAttempts, 0);
    }

    function test_manipulatedWardTotalIsRecordedAndBlocked() public {
        approvePu(1);
        approvePu(2);
        (T.Figures memory agg,,) = collation.computeAggregate(T.Level.Ward, 1);
        // memory structs are reference types: fetch a second, independent copy to tamper with
        (T.Figures memory manipulated,,) = collation.computeAggregate(T.Level.Ward, 1);
        manipulated.candidateVotes[0] += 50; // inflate candidate A by 50 votes
        manipulated.validVotes += 50;
        manipulated.totalVotesCast += 50;
        manipulated.accreditedVoters += 50;

        vm.prank(wardCoOf[1]);
        vm.expectEmit(true, true, true, true);
        emit CollationEngine.MismatchAlert(
            T.Level.Ward,
            1,
            wardCoOf[1],
            T.Field.AccreditedVoters,
            0,
            manipulated.accreditedVoters,
            agg.accreditedVoters,
            1
        );
        bool ok = collation.confirmCollation(T.Level.Ward, 1, manipulated, "bafy-ec8b-1");
        assertFalse(ok);
        assertStatus(T.Level.Ward, 1, T.ResultStatus.Open); // still blocked
        assertEq(collation.mismatchAttemptsOf(T.Level.Ward, 1), 1);
        assertFalse(collation.getCollation(T.Level.Ward, 1).exists);

        // the pre-check view reports the same discrepancy
        (bool pre, T.Field field,, uint256 dv, uint256 cvv) =
            collation.checkDeclared(T.Level.Ward, 1, manipulated);
        assertFalse(pre);
        assertEq(uint8(field), uint8(T.Field.AccreditedVoters));
        assertEq(dv, agg.accreditedVoters + 50);
        assertEq(cvv, agg.accreditedVoters);

        // a single-candidate alteration is pinpointed with its index
        (T.Figures memory swapped,,) = collation.computeAggregate(T.Level.Ward, 1);
        swapped.candidateVotes[1] -= 10;
        swapped.candidateVotes[2] += 10;
        (pre, field,) = _check3(swapped);
        assertFalse(pre);
        assertEq(uint8(field), uint8(T.Field.CandidateVotes));

        // honest totals still go through afterwards; the attempt stays on record
        vm.prank(wardCoOf[1]);
        assertTrue(collation.confirmCollation(T.Level.Ward, 1, agg, "bafy-ec8b-1"));
        assertEq(collation.mismatchAttemptsOf(T.Level.Ward, 1), 1);
    }

    function _check3(T.Figures memory f) internal view returns (bool ok, T.Field field, uint256 idx) {
        (ok, field, idx,,) = collation.checkDeclared(T.Level.Ward, 1, f);
    }

    function test_onlyResponsibleOfficerCanConfirm() public {
        approvePu(1);
        approvePu(2);
        (T.Figures memory agg,,) = collation.computeAggregate(T.Level.Ward, 1);
        vm.prank(wardCoOf[2]);
        vm.expectRevert(
            abi.encodeWithSelector(CollationEngine.NotCollationOfficer.selector, wardCoOf[2], T.Level.Ward, 1)
        );
        collation.confirmCollation(T.Level.Ward, 1, agg, "cid");
        vm.prank(lgaCoOf[1]);
        vm.expectRevert(
            abi.encodeWithSelector(CollationEngine.NotCollationOfficer.selector, lgaCoOf[1], T.Level.Ward, 1)
        );
        collation.confirmCollation(T.Level.Ward, 1, agg, "cid");
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(CollationEngine.NotCollationOfficer.selector, admin, T.Level.Ward, 1)
        );
        collation.confirmCollation(T.Level.Ward, 1, agg, "cid");
    }

    function test_pollingUnitLevelIsNotACollationLevel() public {
        vm.prank(poOf[1]);
        vm.expectRevert(
            abi.encodeWithSelector(CollationEngine.InvalidCollationLevel.selector, T.Level.PollingUnit)
        );
        collation.confirmCollation(T.Level.PollingUnit, 1, goodFigures(), "cid");
    }

    function test_cannotSkipLevels() public {
        // LGA officer cannot collate before the wards are approved even if every PU is approved
        for (uint256 pu = 1; pu <= 4; pu++) {
            approvePu(pu);
        }
        T.Figures memory f = T.emptyFigures(3);
        vm.prank(lgaCoOf[1]);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollationEngine.LowerLevelNotApproved.selector, T.Level.Ward, 1, T.ResultStatus.Open
            )
        );
        collation.confirmCollation(T.Level.LGA, 1, f, "cid");
        // state officer cannot collate before LGAs
        vm.prank(sro);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollationEngine.LowerLevelNotApproved.selector, T.Level.LGA, 1, T.ResultStatus.Open
            )
        );
        collation.confirmCollation(T.Level.State, T.STATE_UNIT_ID, f, "cid");
    }

    function test_cannotReconfirmWhilePendingOrApproved() public {
        approvePu(1);
        approvePu(2);
        (T.Figures memory agg,,) = collation.computeAggregate(T.Level.Ward, 1);
        vm.prank(wardCoOf[1]);
        collation.confirmCollation(T.Level.Ward, 1, agg, "cid");
        vm.prank(wardCoOf[1]);
        vm.expectRevert(
            abi.encodeWithSelector(
                T.InvalidStatus.selector, T.Level.Ward, 1, T.ResultStatus.PendingSignatures
            )
        );
        collation.confirmCollation(T.Level.Ward, 1, agg, "cid-2");
    }

    function test_wardDisputeAndCorrectionFlow() public {
        approvePu(1);
        approvePu(2);
        (T.Figures memory agg,,) = collation.computeAggregate(T.Level.Ward, 1);
        vm.prank(wardCoOf[1]);
        collation.confirmCollation(T.Level.Ward, 1, agg, "bafy-ec8b-1-blurry");

        // ward agent disputes (e.g. the uploaded EC8B scan is unreadable)
        vm.prank(agentOf[1][1][3]);
        verification.raiseDispute(T.Level.Ward, 1, "EC8B scan unreadable", "");
        assertStatus(T.Level.Ward, 1, T.ResultStatus.Frozen);

        // officer re-confirms with a new form (aggregate unchanged) -> FiguresCorrected resolution, round 2
        vm.prank(wardCoOf[1]);
        assertTrue(collation.confirmCollation(T.Level.Ward, 1, agg, "bafy-ec8b-1-clear"));
        assertStatus(T.Level.Ward, 1, T.ResultStatus.Resolved);
        assertEq(collation.getCollation(T.Level.Ward, 1).round, 2);
        assertEq(collation.getCollation(T.Level.Ward, 1).formCid, "bafy-ec8b-1-clear");
        PAV.Dispute memory d = verification.getDispute(1);
        assertEq(uint8(d.resolution.kind), uint8(T.ResolutionType.FiguresCorrected));
        assertEq(d.resolution.resolvedBy, wardCoOf[1]);

        vm.prank(agentOf[1][1][3]);
        verification.acceptResolution(1);
        signAll(T.Level.Ward, 1);
        assertStatus(T.Level.Ward, 1, T.ResultStatus.Approved);
    }

    // ------------------------------------------------------------------
    // Full chain & public verification
    // ------------------------------------------------------------------
    function test_fullChainUpToStateAndPublicVerification() public {
        runToStateApproved();
        assertStatus(T.Level.State, T.STATE_UNIT_ID, T.ResultStatus.Approved);

        // state figures equal the sum of all polling units
        T.Figures memory expected = T.emptyFigures(3);
        for (uint256 pu = 1; pu <= puCount; pu++) {
            expected = sum(expected, figuresFor(pu));
        }
        T.Figures memory state = collation.getFigures(T.Level.State, T.STATE_UNIT_ID);
        assertEq(state.validVotes, expected.validVotes);
        assertEq(state.candidateVotes[2], expected.candidateVotes[2]);
        assertEq(state.registeredVoters, 8000);

        // anyone can re-verify every level
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
        (bool none,,,,) = collation.verifyConsistency(T.Level.Ward, 99);
        assertFalse(none);
    }

    function test_collationAllowedInCollationPhase() public {
        approvePu(1);
        approvePu(2);
        vm.prank(admin);
        election.closeSubmissions();
        (T.Figures memory agg,,) = collation.computeAggregate(T.Level.Ward, 1);
        vm.prank(wardCoOf[1]);
        assertTrue(collation.confirmCollation(T.Level.Ward, 1, agg, "cid"));
    }
}

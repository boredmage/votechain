// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { VoteChainFixture } from "./VoteChainFixture.sol";
import { VoteChainTypes as T } from "../src/VoteChainTypes.sol";
import { ResultUpload } from "../src/ResultUpload.sol";

contract ResultUploadTest is VoteChainFixture {
    function setUp() public override {
        super.setUp();
        activate();
    }

    function _expectRule(T.Rule rule, uint256 expected, uint256 actual) internal {
        vm.expectRevert(
            abi.encodeWithSelector(ResultUpload.ValidationFailed.selector, rule, expected, actual)
        );
    }

    // ------------------------------------------------------------------
    // Happy path
    // ------------------------------------------------------------------
    function test_validSubmissionStoresFiguresAndOpensSigning() public {
        T.Figures memory f = goodFigures();
        vm.prank(poOf[1]);
        vm.expectEmit(true, true, false, false);
        emit ResultUpload.ResultSubmitted(1, 1, poOf[1], bytes32(0), "", 0, 0);
        upload.submitResult(1, f, "bafy-ec8a-1");

        ResultUpload.PollingUnitResult memory r = upload.getResult(1);
        assertTrue(r.exists);
        assertEq(r.round, 1);
        assertEq(r.officer, poOf[1]);
        assertEq(r.formCid, "bafy-ec8a-1");
        assertEq(r.figures.validVotes, 570);
        assertEq(r.figures.candidateVotes[0], 300);
        assertEq(r.blockNumber, block.number);
        assertEq(r.figuresHash, T.figuresHash(T.Level.PollingUnit, 1, f, "bafy-ec8a-1"));
        assertEq(verification.currentFiguresHash(T.Level.PollingUnit, 1), r.figuresHash);
        assertStatus(T.Level.PollingUnit, 1, T.ResultStatus.PendingSignatures);
        assertEq(upload.submissionCount(), 1);
    }

    function test_validateFiguresViewReportsNone() public view {
        (T.Rule rule, uint256 e, uint256 a) = upload.validateFigures(1, goodFigures());
        assertEq(uint8(rule), uint8(T.Rule.None));
        assertEq(e, 0);
        assertEq(a, 0);
    }

    // ------------------------------------------------------------------
    // Table 3.2 rules
    // ------------------------------------------------------------------
    function test_rule1_castExceedsAccredited() public {
        // 600 accredited, 620 cast
        T.Figures memory f = fig(1000, 600, 620, 610, 10, cv3(300, 240, 70));
        vm.prank(poOf[1]);
        _expectRule(T.Rule.CastExceedsAccredited, 600, 620);
        upload.submitResult(1, f, "cid");
    }

    function test_rule2_castExceedsRegistered() public {
        // Use a unit whose register value is unset so the register cross-check does not pre-empt rule 2.
        vm.prank(admin);
        vm.expectRevert(); // registration closed: geography is fixed once Active
        election.addPollingUnit(1, "OY/x", "x", 0);

        // Rule 1 passes (600 <= 700) but rule 2 fires (600 > 500 registered).
        T.Figures memory f = fig(500, 700, 600, 590, 10, cv3(300, 220, 70));
        (T.Rule rule, uint256 e, uint256 a) = T.checkFigures(f, 3);
        assertEq(uint8(rule), uint8(T.Rule.CastExceedsRegistered));
        assertEq(e, 500);
        assertEq(a, 600);

        // and through the contract, reported before the register cross-check
        vm.prank(poOf[1]);
        _expectRule(T.Rule.CastExceedsRegistered, 500, 600);
        upload.submitResult(1, f, "cid");
    }

    function test_rule3_validPlusRejectedMismatch() public {
        // 580 cast but 565 + 10 = 575
        T.Figures memory f = fig(1000, 600, 580, 565, 10, cv3(300, 200, 65));
        vm.prank(poOf[1]);
        _expectRule(T.Rule.ValidPlusRejectedMismatch, 580, 575);
        upload.submitResult(1, f, "cid");
    }

    function test_rule4_candidateSumMismatch() public {
        // candidates sum to 560 but valid is 570
        T.Figures memory f = fig(1000, 600, 580, 570, 10, cv3(300, 200, 60));
        vm.prank(poOf[1]);
        _expectRule(T.Rule.CandidateSumMismatch, 570, 560);
        upload.submitResult(1, f, "cid");
    }

    function test_rule5_accreditedExceedsRegistered() public {
        T.Figures memory f = fig(1000, 1200, 580, 570, 10, cv3(300, 200, 70));
        vm.prank(poOf[1]);
        _expectRule(T.Rule.AccreditedExceedsRegistered, 1000, 1200);
        upload.submitResult(1, f, "cid");
    }

    function test_candidateArrayLengthMustMatchCandidateCount() public {
        uint256[] memory two = new uint256[](2);
        two[0] = 300;
        two[1] = 270;
        T.Figures memory f = fig(1000, 600, 580, 570, 10, two);
        vm.prank(poOf[1]);
        _expectRule(T.Rule.CandidateSumMismatch, 3, 2);
        upload.submitResult(1, f, "cid");
    }

    function test_registerCrossCheck() public {
        // PU register says 1000 registered voters; officer types 1100
        T.Figures memory f = fig(1100, 600, 580, 570, 10, cv3(300, 200, 70));
        vm.prank(poOf[1]);
        _expectRule(T.Rule.RegisterMismatch, 1000, 1100);
        upload.submitResult(1, f, "cid");
    }

    function test_zeroToleranceBoundaryValues() public {
        // Exactly-equal boundaries are valid: accredited == registered, cast == accredited, rejected == 0
        T.Figures memory f = fig(1000, 1000, 1000, 1000, 0, cv3(500, 300, 200));
        vm.prank(poOf[1]);
        upload.submitResult(1, f, "cid");
        assertStatus(T.Level.PollingUnit, 1, T.ResultStatus.PendingSignatures);
    }

    // ------------------------------------------------------------------
    // Access control and state guards
    // ------------------------------------------------------------------
    function test_onlyAssignedPresidingOfficer() public {
        vm.prank(poOf[2]);
        vm.expectRevert(abi.encodeWithSelector(ResultUpload.NotPresidingOfficer.selector, poOf[2], 1));
        upload.submitResult(1, goodFigures(), "cid");

        vm.prank(agentOf[0][1][1]);
        vm.expectRevert(
            abi.encodeWithSelector(ResultUpload.NotPresidingOfficer.selector, agentOf[0][1][1], 1)
        );
        upload.submitResult(1, goodFigures(), "cid");
    }

    function test_unknownPollingUnit() public {
        vm.prank(poOf[1]);
        vm.expectRevert(abi.encodeWithSelector(T.UnknownUnit.selector, T.Level.PollingUnit, 99));
        upload.submitResult(99, goodFigures(), "cid");
    }

    function test_cannotSubmitTwice() public {
        submitPu(1);
        vm.prank(poOf[1]);
        vm.expectRevert(
            abi.encodeWithSelector(
                T.InvalidStatus.selector, T.Level.PollingUnit, 1, T.ResultStatus.PendingSignatures
            )
        );
        upload.submitResult(1, goodFigures(), "cid");
    }

    function test_requiresFormCid() public {
        vm.prank(poOf[1]);
        vm.expectRevert(ResultUpload.EmptyFormCid.selector);
        upload.submitResult(1, goodFigures(), "");
    }

    function test_cancelledUnitRejectsSubmission() public {
        vm.prank(admin);
        election.cancelPollingUnit(1, "bafy-cancel");
        vm.prank(poOf[1]);
        vm.expectRevert(abi.encodeWithSelector(ResultUpload.PollingUnitCancelled.selector, 1));
        upload.submitResult(1, goodFigures(), "cid");
    }

    function test_submissionOnlyInActivePhase() public {
        vm.prank(admin);
        election.closeSubmissions();
        vm.prank(poOf[1]);
        vm.expectRevert(abi.encodeWithSelector(T.WrongPhase.selector, T.Phase.Collation, T.Phase.Active));
        upload.submitResult(1, goodFigures(), "cid");
    }

    function test_resubmitOnlyWhenFrozen() public {
        submitPu(1);
        vm.prank(poOf[1]);
        vm.expectRevert(
            abi.encodeWithSelector(
                T.InvalidStatus.selector, T.Level.PollingUnit, 1, T.ResultStatus.PendingSignatures
            )
        );
        upload.resubmitResult(1, goodFigures(), "cid-2");
    }

    function test_resubmitAfterDisputeValidatesAndBumpsRound() public {
        submitPu(1, goodFigures());
        vm.prank(agentOf[0][1][2]);
        verification.raiseDispute(T.Level.PollingUnit, 1, "Form shows 310 for candidate A", "bafy-evidence");
        assertStatus(T.Level.PollingUnit, 1, T.ResultStatus.Frozen);

        // corrected figures must still satisfy the rules
        vm.prank(poOf[1]);
        _expectRule(T.Rule.CandidateSumMismatch, 570, 580);
        upload.resubmitResult(1, fig(1000, 600, 580, 570, 10, cv3(310, 200, 70)), "bafy-ec8a-1-v2");

        vm.prank(poOf[1]);
        upload.resubmitResult(1, fig(1000, 600, 590, 580, 10, cv3(310, 200, 70)), "bafy-ec8a-1-v2");
        ResultUpload.PollingUnitResult memory r = upload.getResult(1);
        assertEq(r.round, 2);
        assertEq(r.figures.candidateVotes[0], 310);
        assertStatus(T.Level.PollingUnit, 1, T.ResultStatus.Resolved);
    }
}

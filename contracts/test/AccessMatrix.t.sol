// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { VoteChainFixture } from "./VoteChainFixture.sol";
import { VoteChainTypes as T } from "../src/VoteChainTypes.sol";
import { ResultUpload } from "../src/ResultUpload.sol";
import { CollationEngine } from "../src/CollationEngine.sol";
import { AuditDeclaration } from "../src/AuditDeclaration.sol";
import { PartyAgentVerification as PAV } from "../src/PartyAgentVerification.sol";

/// @notice Role-based access matrix (Section 6.6 / Objective 1): every write action is attempted by
///         every *other* stakeholder category and must revert. Complements the per-module tests.
contract AccessMatrixTest is VoteChainFixture {
    address[] internal everyone;

    function setUp() public override {
        super.setUp();
        activate();
        submitPu(1);
        everyone = [
            admin,
            poOf[1],
            poOf[2],
            agentOf[0][1][1],
            agentOf[1][1][1],
            wardCoOf[1],
            lgaCoOf[1],
            sro,
            auditor,
            publisher,
            stranger
        ];
    }

    function _others(address allowed) internal view returns (address[] memory list) {
        list = new address[](everyone.length);
        uint256 n;
        for (uint256 i = 0; i < everyone.length; i++) {
            if (everyone[i] != allowed) list[n++] = everyone[i];
        }
        assembly {
            mstore(list, n)
        }
    }

    function test_onlyPresidingOfficerUploads() public {
        address[] memory others = _others(poOf[2]);
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(ResultUpload.NotPresidingOfficer.selector, others[i], 2));
            upload.submitResult(2, goodFigures(), "cid");
        }
    }

    function test_onlyPollingUnitAgentsSignOrDispute() public {
        bytes32 h = verification.currentFiguresHash(T.Level.PollingUnit, 1);
        address[] memory others = _others(agentOf[0][1][1]);
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(
                abi.encodeWithSelector(PAV.NotAgentForUnit.selector, others[i], T.Level.PollingUnit, 1)
            );
            verification.signResult(T.Level.PollingUnit, 1, h);
            vm.prank(others[i]);
            vm.expectRevert(
                abi.encodeWithSelector(PAV.NotAgentForUnit.selector, others[i], T.Level.PollingUnit, 1)
            );
            verification.raiseDispute(T.Level.PollingUnit, 1, "x", "");
        }
    }

    function test_onlyUnitOfficerResolves() public {
        vm.prank(agentOf[0][1][1]);
        verification.raiseDispute(T.Level.PollingUnit, 1, "x", "");
        address[] memory others = _others(poOf[1]);
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(
                abi.encodeWithSelector(PAV.NotOfficerForUnit.selector, others[i], T.Level.PollingUnit, 1)
            );
            verification.resolveDispute(T.Level.PollingUnit, 1, 1, "cid", "note");
        }
    }

    function test_onlyWardOfficerCollatesWard() public {
        signAll(T.Level.PollingUnit, 1);
        approvePu(2);
        (T.Figures memory agg,,) = collation.computeAggregate(T.Level.Ward, 1);
        address[] memory others = _others(wardCoOf[1]);
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(
                abi.encodeWithSelector(
                    CollationEngine.NotCollationOfficer.selector, others[i], T.Level.Ward, 1
                )
            );
            collation.confirmCollation(T.Level.Ward, 1, agg, "cid");
        }
    }

    function test_onlyAuditorRulesAndOnlyPublisherDeclares() public {
        address[] memory others = _others(auditor);
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(PAV.NotAuditor.selector, others[i]));
            verification.ruleOnEscalation(1, false, "cid");
        }
        others = _others(publisher);
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(AuditDeclaration.NotResultPublisher.selector, others[i]));
            audit.declareResult();
        }
    }

    function test_inecAdminHasNoOperationalPowers() public {
        // The administrator cannot upload, sign, collate, audit or declare – no single point of control.
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(ResultUpload.NotPresidingOfficer.selector, admin, 2));
        upload.submitResult(2, goodFigures(), "cid");
        bytes32 h = verification.currentFiguresHash(T.Level.PollingUnit, 1);
        vm.expectRevert(abi.encodeWithSelector(PAV.NotAgentForUnit.selector, admin, T.Level.PollingUnit, 1));
        verification.signResult(T.Level.PollingUnit, 1, h);
        vm.expectRevert(abi.encodeWithSelector(AuditDeclaration.NotResultPublisher.selector, admin));
        audit.declareResult();
        vm.expectRevert(abi.encodeWithSelector(T.NotAuthorised.selector, admin));
        election.markDeclared();
        vm.stopPrank();
    }
}

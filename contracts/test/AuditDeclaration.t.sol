// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import { VoteChainFixture } from "./VoteChainFixture.sol";
import { VoteChainTypes as T } from "../src/VoteChainTypes.sol";
import { AuditDeclaration } from "../src/AuditDeclaration.sol";
import { PartyAgentVerification as PAV } from "../src/PartyAgentVerification.sol";

contract AuditDeclarationTest is VoteChainFixture {
    function setUp() public override {
        super.setUp();
        activate();
    }

    function test_notReadyBeforeStateApproval() public {
        (bool ready, string memory reason) = audit.isReadyForAudit();
        assertFalse(ready);
        assertEq(reason, "state collation not approved by state party agents");

        vm.expectRevert(
            abi.encodeWithSelector(AuditDeclaration.StateResultNotApproved.selector, T.ResultStatus.Open)
        );
        audit.verifyAndSign(hex"00", "cid");
    }

    function test_publisherCannotDeclareWithoutAudit() public {
        runToStateApproved();
        vm.prank(publisher);
        vm.expectRevert(AuditDeclaration.AuditNotApproved.selector);
        audit.declareResult();
    }

    function test_onlyPublisherCanDeclare() public {
        runToStateApproved();
        audit.verifyAndSign(auditorSignature(), "bafy-report");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AuditDeclaration.NotResultPublisher.selector, admin));
        audit.declareResult();
        vm.prank(auditor);
        vm.expectRevert(abi.encodeWithSelector(AuditDeclaration.NotResultPublisher.selector, auditor));
        audit.declareResult();
    }

    function test_signatureMustComeFromRegisteredAuditor() public {
        runToStateApproved();
        (address impostor, uint256 impostorPk) = makeAddrAndKey("impostor");
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(audit.auditDigest());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(impostorPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.expectRevert(
            abi.encodeWithSelector(AuditDeclaration.NotAuditorSignature.selector, impostor, auditor)
        );
        audit.verifyAndSign(sig, "cid");
    }

    function test_signatureOverWrongDigestIsRejected() public {
        runToStateApproved();
        // auditor signs a different message (e.g. a stale hash)
        bytes32 wrong = MessageHashUtils.toEthSignedMessageHash(keccak256("some other result"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(auditorPk, wrong);
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.expectRevert(); // recovers to a different address -> NotAuditorSignature(recovered, auditor)
        audit.verifyAndSign(sig, "cid");
    }

    function test_malformedSignatureReverts() public {
        runToStateApproved();
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 3));
        audit.verifyAndSign(hex"010203", "cid");
    }

    function test_escalationGate() public {
        // Escalate a dispute on PU 1 and keep it pending while the rest of the chain is built.
        submitPu(1);
        vm.prank(agentOf[0][1][1]);
        verification.raiseDispute(T.Level.PollingUnit, 1, "reason", "");
        vm.prank(poOf[1]);
        verification.resolveDispute(T.Level.PollingUnit, 1, 1, "cid", "note");
        vm.prank(agentOf[0][1][1]);
        verification.escalateDispute(1);
        assertEq(verification.pendingEscalations(), 1);
        assertEq(audit.escalatedDisputes().length, 1);

        // The state result cannot even be collated while PU 1 is escalated (ward 1 blocked)
        (, bool complete, uint256 blocking) = collation.computeAggregate(T.Level.Ward, 1);
        assertFalse(complete);
        assertEq(blocking, 1);

        // auditor dismisses -> remaining agents sign -> chain completes -> audit possible
        vm.prank(auditor);
        verification.ruleOnEscalation(1, false, "bafy-ruling");
        bytes32 h = verification.currentFiguresHash(T.Level.PollingUnit, 1);
        vm.prank(agentOf[0][1][2]);
        verification.signResult(T.Level.PollingUnit, 1, h);
        vm.prank(agentOf[0][1][3]);
        verification.signResult(T.Level.PollingUnit, 1, h);
        assertStatus(T.Level.PollingUnit, 1, T.ResultStatus.Approved);

        for (uint256 pu = 2; pu <= puCount; pu++) {
            approvePu(pu);
        }
        for (uint256 w = 1; w <= wardCount; w++) {
            collate(T.Level.Ward, w);
        }
        for (uint256 l = 1; l <= lgaCount; l++) {
            collate(T.Level.LGA, l);
        }
        collate(T.Level.State, T.STATE_UNIT_ID);
        (bool ready,) = audit.isReadyForAudit();
        assertTrue(ready);
        audit.verifyAndSign(auditorSignature(), "bafy-report");
        assertTrue(audit.auditApproved());
    }

    function test_auditRecordAndDeclaration() public {
        runToStateApproved();
        bytes memory sig = auditorSignature();
        vm.expectEmit(true, false, false, true);
        emit AuditDeclaration.AuditApproved(
            auditor, audit.stateResultHash(), "bafy-report", uint64(block.timestamp)
        );
        audit.verifyAndSign(sig, "bafy-report");

        AuditDeclaration.AuditRecord memory a = audit.getAudit();
        assertTrue(a.approved);
        assertEq(a.auditor, auditor);
        assertEq(a.stateResultHash, audit.stateResultHash());
        assertEq(a.reportCid, "bafy-report");
        assertEq(keccak256(a.signature), keccak256(sig));

        // cannot audit twice
        vm.expectRevert(AuditDeclaration.AlreadyAudited.selector);
        audit.verifyAndSign(sig, "bafy-report-2");

        vm.prank(publisher);
        audit.declareResult();
        AuditDeclaration.Declaration memory d = audit.getDeclaration();
        assertTrue(d.declared);
        assertEq(d.publisher, publisher);
        assertEq(d.winnerCandidateIndex, 0); // candidate A leads in figuresFor()
        assertEq(d.winnerPartyId, 1);
        assertFalse(d.tie);
        assertEq(d.figures.candidateVotes[0], d.winnerVotes);
        assertEq(uint8(election.phase()), uint8(T.Phase.Declared));
        assertStatus(T.Level.State, T.STATE_UNIT_ID, T.ResultStatus.Declared);

        // cannot declare twice
        vm.prank(publisher);
        vm.expectRevert(AuditDeclaration.AlreadyDeclared.selector);
        audit.declareResult();
    }

    function test_declaredElectionFreezesAgentActions() public {
        runToDeclared();
        vm.prank(agentOf[0][1][1]);
        vm.expectRevert(abi.encodeWithSelector(PAV.NotOperational.selector, T.Phase.Declared));
        verification.raiseDispute(T.Level.PollingUnit, 1, "late", "");
    }

    function test_tieIsFlagged() public {
        // equal votes for candidates A and B at every polling unit
        for (uint256 pu = 1; pu <= puCount; pu++) {
            submitPu(pu, fig(1000, 500, 400, 400, 0, cv3(150, 150, 100)));
            signAll(T.Level.PollingUnit, pu);
        }
        for (uint256 w = 1; w <= wardCount; w++) {
            collate(T.Level.Ward, w);
        }
        for (uint256 l = 1; l <= lgaCount; l++) {
            collate(T.Level.LGA, l);
        }
        collate(T.Level.State, T.STATE_UNIT_ID);
        audit.verifyAndSign(auditorSignature(), "bafy-report");
        vm.prank(publisher);
        audit.declareResult();
        AuditDeclaration.Declaration memory d = audit.getDeclaration();
        assertTrue(d.tie);
        assertEq(d.winnerPartyId, 0);
        assertEq(d.winnerVotes, 1200);
    }

    function test_digestIsDomainSeparated() public {
        runToStateApproved();
        bytes32 expected = keccak256(
            abi.encode("VoteChain.AuditApproval", block.chainid, address(audit), audit.stateResultHash())
        );
        assertEq(audit.auditDigest(), expected);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { VoteChainFixture } from "../VoteChainFixture.sol";
import { VoteChainTypes as T } from "../../src/VoteChainTypes.sol";
import { ResultUpload } from "../../src/ResultUpload.sol";
import { CollationEngine } from "../../src/CollationEngine.sol";
import { AuditDeclaration } from "../../src/AuditDeclaration.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @dev Exposes the internal library function so it can be fuzzed directly.
contract ChecksHarness {
    function check(T.Figures memory f, uint256 n) external pure returns (T.Rule, uint256, uint256) {
        return T.checkFigures(f, n);
    }
}

/// @notice Stateless fuzzing of the six arithmetic rules (Table 3.2), the register cross-check, the
///         rule-6 collation equality, and the audit-signature checks.
contract FiguresFuzzTest is VoteChainFixture {
    ChecksHarness internal h;

    function setUp() public override {
        super.setUp();
        activate();
        h = new ChecksHarness();
    }

    // ------------------------------------------------------------------
    // Reference model (independent re-implementation of Table 3.2, first violation wins)
    // ------------------------------------------------------------------
    function _model(T.Figures memory f, uint256 n) internal pure returns (T.Rule) {
        if (f.candidateVotes.length != n) return T.Rule.CandidateSumMismatch;
        if (f.totalVotesCast > f.accreditedVoters) return T.Rule.CastExceedsAccredited;
        if (f.totalVotesCast > f.registeredVoters) return T.Rule.CastExceedsRegistered;
        if (f.validVotes + f.rejectedVotes != f.totalVotesCast) return T.Rule.ValidPlusRejectedMismatch;
        uint256 s;
        for (uint256 i; i < f.candidateVotes.length; i++) {
            s += f.candidateVotes[i];
        }
        if (s != f.validVotes) return T.Rule.CandidateSumMismatch;
        if (f.accreditedVoters > f.registeredVoters) return T.Rule.AccreditedExceedsRegistered;
        return T.Rule.None;
    }

    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_checkFiguresMatchesReferenceModel(
        uint64 reg,
        uint64 acc,
        uint64 cast,
        uint64 valid,
        uint64 rej,
        uint64 c0,
        uint64 c1,
        uint64 c2
    ) public view {
        T.Figures memory f = fig(reg, acc, cast, valid, rej, cv3(c0, c1, c2));
        (T.Rule r,,) = h.check(f, 3);
        assertEq(uint8(r), uint8(_model(f, 3)));
    }

    /// @dev Biased generator: start from a valid set and perturb one field, so every rule is hit often.
    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_singlePerturbationReportsTheRightRule(uint256 seed, uint8 which, uint256 delta) public view {
        T.Figures memory f = _validFrom(seed, 1000);
        delta = bound(delta, 1, 500);
        which = uint8(bound(which, 0, 6));
        if (which == 0) f.totalVotesCast = f.accreditedVoters + delta; // rule 1 (first)
        if (which == 1) {
            f.accreditedVoters = f.registeredVoters + delta + 10; // make room so rule 1 doesn't fire
            f.totalVotesCast = f.registeredVoters + delta; // rule 2
        }
        if (which == 2) f.rejectedVotes += delta; // rule 3
        if (which == 3) {
            f.candidateVotes[0] += delta; // rule 4
        }
        if (which == 4) f.accreditedVoters = f.registeredVoters + delta; // rule 5
        if (which == 5) f.registeredVoters += delta; // register cross-check only (still internally valid)
        if (which == 6) f.candidateVotes = new uint256[](2); // wrong length
        (T.Rule r,,) = upload.validateFigures(1, f);
        T.Rule expected = _model(f, 3);
        if (expected == T.Rule.None && f.registeredVoters != 1000) expected = T.Rule.RegisterMismatch;
        assertEq(uint8(r), uint8(expected));
        assertTrue(r != T.Rule.None, "perturbation must be caught");
    }

    /// forge-config: default.fuzz.runs = 500
    function testFuzz_validFiguresAlwaysAcceptedOnChain(uint256 seed, uint256 puId) public {
        puId = bound(puId, 1, puCount);
        T.Figures memory f = _validFrom(seed, 1000);
        submitPu(puId, f);
        assertStatus(T.Level.PollingUnit, puId, T.ResultStatus.PendingSignatures);
        assertEq(upload.figuresHashOf(puId), verification.currentFiguresHash(T.Level.PollingUnit, puId));
    }

    /// forge-config: default.fuzz.runs = 500
    function testFuzz_invalidFiguresAlwaysRevertOnChain(uint256 seed, uint8 which, uint256 delta) public {
        T.Figures memory f = _validFrom(seed, 1000);
        delta = bound(delta, 1, 500);
        which = uint8(bound(which, 0, 4));
        if (which == 0) f.totalVotesCast = f.accreditedVoters + delta;
        if (which == 1) f.rejectedVotes += delta;
        if (which == 2) f.candidateVotes[2] += delta;
        if (which == 3) f.accreditedVoters = f.registeredVoters + delta;
        if (which == 4) f.registeredVoters = 1000 + delta;
        vm.prank(poOf[1]);
        vm.expectRevert(); // ValidationFailed(...)
        upload.submitResult(1, f, "bafy");
        assertStatus(T.Level.PollingUnit, 1, T.ResultStatus.Open);
    }

    /// @dev Info finding: overflow in rule 3 / rule 4 panics (0x11) instead of ValidationFailed.
    function testFuzz_overflowPanicsInsteadOfValidationFailed(uint256 v) public {
        v = bound(v, 1, type(uint256).max);
        T.Figures memory f = fig(type(uint256).max, type(uint256).max, 0, type(uint256).max, v, cv3(0, 0, 0));
        vm.expectRevert(abi.encodeWithSignature("Panic(uint256)", 0x11));
        h.check(f, 3);
    }

    // ------------------------------------------------------------------
    // Rule 6: collation equality
    // ------------------------------------------------------------------
    /// forge-config: default.fuzz.runs = 300
    function testFuzz_wardAggregateIsExactSumAndAnyPerturbationIsAlerted(
        uint256 s1,
        uint256 s2,
        uint8 field,
        uint256 delta,
        bool up
    ) public {
        T.Figures memory f1 = _validFrom(s1, 1000);
        T.Figures memory f2 = _validFrom(s2, 1000);
        submitPu(1, f1);
        signAll(T.Level.PollingUnit, 1);
        submitPu(2, f2);
        signAll(T.Level.PollingUnit, 2);

        (T.Figures memory agg, bool complete,) = collation.computeAggregate(T.Level.Ward, 1);
        assertTrue(complete);
        T.Figures memory expect = sum(f1, f2);
        assertEq(keccak256(abi.encode(agg)), keccak256(abi.encode(expect)), "aggregate != sum");

        // perturb exactly one field
        T.Figures memory bad = sum(f1, f2);
        delta = bound(delta, 1, 1e6);
        field = uint8(bound(field, 0, 7));
        if (!up && field < 5) {
            uint256 base = [bad.registeredVoters, bad.accreditedVoters, bad.totalVotesCast, bad.validVotes, bad.rejectedVotes][field];
            if (delta > base) up = true;
        }
        if (field == 0) bad.registeredVoters = up ? bad.registeredVoters + delta : bad.registeredVoters - delta;
        if (field == 1) bad.accreditedVoters = up ? bad.accreditedVoters + delta : bad.accreditedVoters - delta;
        if (field == 2) bad.totalVotesCast = up ? bad.totalVotesCast + delta : bad.totalVotesCast - delta;
        if (field == 3) bad.validVotes = up ? bad.validVotes + delta : bad.validVotes - delta;
        if (field == 4) bad.rejectedVotes = up ? bad.rejectedVotes + delta : bad.rejectedVotes - delta;
        if (field >= 5) bad.candidateVotes[field - 5] += delta;

        vm.prank(wardCoOf[1]);
        vm.expectEmit(true, true, true, false, address(collation));
        emit CollationEngine.MismatchAlert(T.Level.Ward, 1, wardCoOf[1], T.Field.RegisteredVoters, 0, 0, 0, 1);
        bool ok = collation.confirmCollation(T.Level.Ward, 1, bad, "bafy-ec8b");
        assertFalse(ok);
        assertStatus(T.Level.Ward, 1, T.ResultStatus.Open);
        assertEq(collation.mismatchAttemptsOf(T.Level.Ward, 1), 1);

        vm.prank(wardCoOf[1]);
        assertTrue(collation.confirmCollation(T.Level.Ward, 1, expect, "bafy-ec8b"));
        assertStatus(T.Level.Ward, 1, T.ResultStatus.PendingSignatures);
    }

    // ------------------------------------------------------------------
    // Audit signature: forgery, malleability, replay, missing EIP-191 prefix
    // ------------------------------------------------------------------
    /// forge-config: default.fuzz.runs = 200
    function testFuzz_onlyTheAuditorKeyIsAccepted(uint256 pk) public {
        pk = bound(pk, 1, 115792089237316195423570985008687907852837564279074904382605163141518161494336);
        vm.assume(pk != auditorPk);
        runToStateApproved();
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(audit.auditDigest());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        vm.expectRevert(abi.encodeWithSelector(AuditDeclaration.NotAuditorSignature.selector, vm.addr(pk), auditor));
        audit.verifyAndSign(abi.encodePacked(r, s, v), "cid");
    }

    function test_highSMalleatedSignatureRejected() public {
        runToStateApproved();
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(audit.auditDigest());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(auditorPk, digest);
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 s2 = bytes32(n - uint256(s));
        uint8 v2 = v == 27 ? 28 : 27;
        // ecrecover itself would accept the malleated form ...
        assertEq(ecrecover(digest, v2, r, s2), auditor);
        // ... but OpenZeppelin ECDSA rejects high-s
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, s2));
        audit.verifyAndSign(abi.encodePacked(r, s2, v2), "cid");
    }

    function test_rawDigestWithoutEip191PrefixRejected() public {
        runToStateApproved();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(auditorPk, audit.auditDigest());
        vm.expectRevert(); // NotAuditorSignature(recovered != auditor)
        audit.verifyAndSign(abi.encodePacked(r, s, v), "cid");
    }

    function test_signatureNotReplayableAcrossChains() public {
        runToStateApproved();
        bytes memory sig = auditorSignature();
        vm.chainId(11155111); // e.g. the same deployment address on Sepolia
        vm.expectRevert();
        audit.verifyAndSign(sig, "cid");
    }

    function test_signatureNotReplayableAcrossDeployments() public {
        runToStateApproved();
        bytes memory sig = auditorSignature();
        AuditDeclaration other = new AuditDeclaration(address(election), address(verification), address(collation));
        assertEq(other.stateResultHash(), audit.stateResultHash());
        assertTrue(other.auditDigest() != audit.auditDigest());
        vm.expectRevert();
        other.verifyAndSign(sig, "cid");
    }

    function test_signatureNotReusableForDifferentStateResult() public {
        // a signature made over one state hash is useless for another: build digest manually
        runToStateApproved();
        bytes32 fake = keccak256(abi.encode("VoteChain.AuditApproval", block.chainid, address(audit), bytes32(uint256(1))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(auditorPk, MessageHashUtils.toEthSignedMessageHash(fake));
        vm.expectRevert();
        audit.verifyAndSign(abi.encodePacked(r, s, v), "cid");
    }

    // ------------------------------------------------------------------
    // generator
    // ------------------------------------------------------------------
    function _validFrom(uint256 seed, uint256 reg) internal pure returns (T.Figures memory f) {
        uint256 acc = uint256(keccak256(abi.encode(seed, "acc"))) % (reg + 1);
        uint256 cast = acc == 0 ? 0 : uint256(keccak256(abi.encode(seed, "cast"))) % (acc + 1);
        uint256 rej = cast == 0 ? 0 : uint256(keccak256(abi.encode(seed, "rej"))) % (cast + 1);
        uint256 valid = cast - rej;
        uint256 a = valid == 0 ? 0 : uint256(keccak256(abi.encode(seed, "a"))) % (valid + 1);
        uint256 b = (valid - a) == 0 ? 0 : uint256(keccak256(abi.encode(seed, "b"))) % (valid - a + 1);
        uint256 c = valid - a - b;
        f = fig(reg, acc, cast, valid, rej, cv3(a, b, c));
    }
}

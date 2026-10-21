// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import { VoteChainFixture } from "../VoteChainFixture.sol";
import { VoteChainTypes as T } from "../../src/VoteChainTypes.sol";
import { ElectionManager } from "../../src/ElectionManager.sol";
import { ResultUpload } from "../../src/ResultUpload.sol";
import { PartyAgentVerification as PAV } from "../../src/PartyAgentVerification.sol";
import { CollationEngine } from "../../src/CollationEngine.sol";
import { AuditDeclaration } from "../../src/AuditDeclaration.sol";
import { IPartyAgentVerification } from "../../src/interfaces/IVoteChain.sol";

/// @notice Read-only view of the fixture's actor book, so the handler can act as any stakeholder.
interface IActorBook {
    function agentAt(T.Level level, uint256 unitId, uint256 party) external view returns (address);
    function officerAt(T.Level level, uint256 unitId) external view returns (address);
    function auditorKey() external view returns (uint256);
    function adminAddr() external view returns (address);
    function publisherAddr() external view returns (address);
    function nPu() external view returns (uint256);
    function nWard() external view returns (uint256);
    function nLga() external view returns (uint256);
}

/// @notice Random but role-correct (and sometimes role-incorrect) stakeholder actions.
contract VoteChainHandler is Test {
    ElectionManager internal election;
    ResultUpload internal upload;
    PAV internal verification;
    CollationEngine internal collation;
    AuditDeclaration internal audit;
    IActorBook internal book;

    uint256 internal constant PARTIES = 3;

    // ghosts
    mapping(bytes32 => bytes32) public ghostApprovedHash; // unit key => hash at first approval
    mapping(bytes32 => bool) public ghostWasApproved;
    uint256 public ghostMismatchAlerts;
    uint256 public ghostForgedAuditAccepted; // must stay 0
    uint256 public ghostOutOfScopeSuccess; // must stay 0
    mapping(string => uint256) public calls;

    constructor(
        ElectionManager e,
        ResultUpload u,
        PAV v,
        CollationEngine c,
        AuditDeclaration a,
        IActorBook b
    ) {
        election = e;
        upload = u;
        verification = v;
        collation = c;
        audit = a;
        book = b;
    }

    // ------------------------------------------------------------------
    // unit selection
    // ------------------------------------------------------------------
    function _unit(uint256 levelSeed, uint256 unitSeed) internal view returns (T.Level level, uint256 unitId) {
        level = T.Level(levelSeed % 4);
        if (level == T.Level.PollingUnit) unitId = 1 + unitSeed % book.nPu();
        else if (level == T.Level.Ward) unitId = 1 + unitSeed % book.nWard();
        else if (level == T.Level.LGA) unitId = 1 + unitSeed % book.nLga();
        else unitId = 1;
    }

    function _figures(uint256 seed) internal pure returns (T.Figures memory f) {
        uint256 reg = 1000;
        uint256 acc = uint256(keccak256(abi.encode(seed, 1))) % (reg + 1);
        uint256 cast = acc == 0 ? 0 : uint256(keccak256(abi.encode(seed, 2))) % (acc + 1);
        uint256 rej = cast == 0 ? 0 : uint256(keccak256(abi.encode(seed, 3))) % (cast / 10 + 1);
        uint256 valid = cast - rej;
        uint256 a = valid == 0 ? 0 : uint256(keccak256(abi.encode(seed, 4))) % (valid + 1);
        uint256 b = valid - a == 0 ? 0 : uint256(keccak256(abi.encode(seed, 5))) % (valid - a + 1);
        f.registeredVoters = reg;
        f.accreditedVoters = acc;
        f.totalVotesCast = cast;
        f.validVotes = valid;
        f.rejectedVotes = rej;
        f.candidateVotes = new uint256[](3);
        f.candidateVotes[0] = a;
        f.candidateVotes[1] = b;
        f.candidateVotes[2] = valid - a - b;
    }

    // ------------------------------------------------------------------
    // actions
    // ------------------------------------------------------------------
    function submit(uint256 puSeed, uint256 figSeed, bool corrupt) external {
        uint256 pu = 1 + puSeed % book.nPu();
        T.Figures memory f = _figures(figSeed);
        if (corrupt) f.validVotes += 1; // must be rejected by rule 3
        T.ResultStatus s = verification.statusOf(T.Level.PollingUnit, pu);
        vm.startPrank(book.officerAt(T.Level.PollingUnit, pu));
        if (s == T.ResultStatus.Open) {
            try upload.submitResult(pu, f, string.concat("bafy-", vm.toString(figSeed))) {
                calls["submit"]++;
                if (corrupt) ghostOutOfScopeSuccess++;
            } catch { }
        } else if (s == T.ResultStatus.Frozen) {
            try upload.resubmitResult(pu, f, string.concat("bafy-r-", vm.toString(figSeed))) {
                calls["resubmit"]++;
                if (corrupt) ghostOutOfScopeSuccess++;
            } catch { }
        }
        vm.stopPrank();
    }

    function sign(uint256 levelSeed, uint256 unitSeed, uint256 partySeed, bool objection, bool wrongUnit)
        external
    {
        (T.Level level, uint256 unitId) = _unit(levelSeed, unitSeed);
        address signer = book.agentAt(level, unitId, 1 + partySeed % PARTIES);
        if (wrongUnit) {
            // an agent of a *different* unit / level tries to sign this unit
            (T.Level l2, uint256 u2) = _unit(levelSeed ^ 1, unitSeed ^ 1);
            signer = book.agentAt(l2, u2, 1 + partySeed % PARTIES);
        }
        bytes32 h = verification.currentFiguresHash(level, unitId);
        vm.prank(signer);
        if (objection) {
            try verification.signWithObjection(level, unitId, h, "protest") {
                calls["sign"]++;
                (bool ok,) = election.isAgentFor(level, unitId, signer);
                if (!ok) ghostOutOfScopeSuccess++;
            } catch { }
        } else {
            try verification.signResult(level, unitId, h) {
                calls["sign"]++;
                (bool ok,) = election.isAgentFor(level, unitId, signer);
                if (!ok) ghostOutOfScopeSuccess++;
            } catch { }
        }
        _snapshot();
    }

    function signAllAgents(uint256 levelSeed, uint256 unitSeed) external {
        (T.Level level, uint256 unitId) = _unit(levelSeed, unitSeed);
        bytes32 h = verification.currentFiguresHash(level, unitId);
        for (uint256 p = 1; p <= PARTIES; p++) {
            vm.prank(book.agentAt(level, unitId, p));
            try verification.signResult(level, unitId, h) {
                calls["sign"]++;
            } catch { }
        }
        _snapshot();
    }

    function dispute(uint256 levelSeed, uint256 unitSeed, uint256 partySeed) external {
        (T.Level level, uint256 unitId) = _unit(levelSeed, unitSeed);
        vm.prank(book.agentAt(level, unitId, 1 + partySeed % PARTIES));
        try verification.raiseDispute(level, unitId, "dispute", "bafy-ev") {
            calls["dispute"]++;
        } catch { }
    }

    function resolve(uint256 levelSeed, uint256 unitSeed, uint256 figSeed) external {
        (T.Level level, uint256 unitId) = _unit(levelSeed, unitSeed);
        IPartyAgentVerification.ResultRecord memory r = verification.getRecord(level, unitId);
        if (r.status != T.ResultStatus.Frozen) return;
        address officer = book.officerAt(level, unitId);
        PAV.Dispute memory d = verification.getDispute(r.activeDisputeId);
        if (!d.requiresCorrection && figSeed % 2 == 0) {
            vm.prank(officer);
            try verification.resolveDispute(level, unitId, r.activeDisputeId, "bafy-res", "ok") {
                calls["resolve"]++;
            } catch { }
            return;
        }
        if (level == T.Level.PollingUnit) {
            vm.prank(officer);
            try upload.resubmitResult(unitId, _figures(figSeed), "bafy-corr") {
                calls["correct"]++;
            } catch { }
        } else {
            (T.Figures memory agg, bool complete,) = collation.computeAggregate(level, unitId);
            if (!complete) return;
            vm.prank(officer);
            try collation.confirmCollation(level, unitId, agg, string.concat("bafy-c-", vm.toString(figSeed))) {
                calls["correct"]++;
            } catch { }
        }
    }

    function accept(uint256 disputeSeed) external {
        uint256 n = verification.disputeCount();
        if (n == 0) return;
        uint256 id = 1 + disputeSeed % n;
        vm.prank(verification.getDispute(id).agent);
        try verification.acceptResolution(id) {
            calls["accept"]++;
        } catch { }
        _snapshot();
    }

    function escalate(uint256 disputeSeed) external {
        uint256 n = verification.disputeCount();
        if (n == 0) return;
        uint256 id = 1 + disputeSeed % n;
        vm.prank(verification.getDispute(id).agent);
        try verification.escalateDispute(id) {
            calls["escalate"]++;
        } catch { }
    }

    function rule(uint256 disputeSeed, bool upheld) external {
        uint256 n = verification.disputeCount();
        if (n == 0) return;
        uint256 id = 1 + disputeSeed % n;
        vm.prank(election.auditor());
        try verification.ruleOnEscalation(id, upheld, "bafy-ruling") {
            calls["rule"]++;
        } catch { }
        _snapshot();
    }

    function collate(uint256 levelSeed, uint256 unitSeed, uint256 perturb) external {
        (T.Level level, uint256 unitId) = _unit(1 + levelSeed % 3, unitSeed);
        if (verification.statusOf(level, unitId) != T.ResultStatus.Open) return;
        (T.Figures memory agg, bool complete,) = collation.computeAggregate(level, unitId);
        if (!complete) return;
        if (perturb % 3 == 0) agg.candidateVotes[perturb % 3] += 1 + perturb % 7; // tampering attempt
        vm.prank(book.officerAt(level, unitId));
        try collation.confirmCollation(level, unitId, agg, "bafy-form") returns (bool ok) {
            if (ok) calls["collate"]++;
            else ghostMismatchAlerts++;
            if (ok && perturb % 3 == 0) ghostOutOfScopeSuccess++;
        } catch { }
    }

    function auditAttempt(uint256 pkSeed, bool useAuditor) external {
        uint256 pk = useAuditor ? book.auditorKey() : 1 + pkSeed % 1e30;
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(audit.auditDigest());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        try audit.verifyAndSign(abi.encodePacked(r, s, v), "bafy-audit") {
            calls["audit"]++;
            if (vm.addr(pk) != election.auditor()) ghostForgedAuditAccepted++;
        } catch { }
    }

    function declare(bool asPublisher) external {
        vm.prank(asPublisher ? book.publisherAddr() : book.adminAddr());
        try audit.declareResult() {
            calls["declare"]++;
            if (!asPublisher) ghostOutOfScopeSuccess++;
        } catch { }
        _snapshot();
    }

    function cancel(uint256 puSeed) external {
        if (puSeed % 25 != 0) return; // keep cancellations rare so random walks still reach declaration
        uint256 pu = 1 + (puSeed / 25) % book.nPu();
        vm.prank(book.adminAddr());
        try election.cancelPollingUnit(pu, "bafy-cancel") {
            calls["cancel"]++;
        } catch { }
    }

    /// @dev Honest "next step" driver so that random walks regularly reach the upper levels. Performs up
    ///      to `steps` honest actions (upload, sign, resolve/accept/dismiss disputes, collate, audit, declare).
    function advance(uint256 seed, uint8 steps) external {
        steps = uint8(bound(steps, 1, 40));
        seed = seed % 1e30; // avoid seed + i overflow
        for (uint256 i = 0; i < steps; i++) {
            if (!_step(seed + i)) break;
        }
        _snapshot();
    }

    function _step(uint256 seed) internal returns (bool) {
        uint256 nPu = book.nPu();
        for (uint256 i = 0; i < nPu; i++) {
            uint256 pu = 1 + (seed + i) % nPu;
            if (election.isPollingUnitCancelled(pu)) continue;
            T.ResultStatus s = verification.statusOf(T.Level.PollingUnit, pu);
            if (s == T.ResultStatus.Open) {
                if (election.phase() != T.Phase.Active) continue;
                address po = book.officerAt(T.Level.PollingUnit, pu);
                T.Figures memory f = _figures(seed + i);
                vm.prank(po);
                try upload.submitResult(pu, f, "bafy-adv") { calls["submit"]++; } catch { }
                return true;
            }
            if (s != T.ResultStatus.Approved && s != T.ResultStatus.Declared) {
                return _honest(T.Level.PollingUnit, pu, seed);
            }
        }
        for (uint8 l = 1; l < 4; l++) {
            uint256 n = l == 1 ? book.nWard() : l == 2 ? book.nLga() : 1;
            for (uint256 u = 1; u <= n; u++) {
                T.Level level = T.Level(l);
                T.ResultStatus s = verification.statusOf(level, u);
                if (s == T.ResultStatus.Open) {
                    (T.Figures memory agg, bool complete,) = collation.computeAggregate(level, u);
                    if (!complete) return false;
                    address officer = book.officerAt(level, u);
                    vm.prank(officer);
                    try collation.confirmCollation(level, u, agg, "bafy-adv") returns (bool ok) {
                        if (ok) calls["collate"]++;
                    } catch { }
                    return true;
                }
                if (s != T.ResultStatus.Approved && s != T.ResultStatus.Declared) return _honest(level, u, seed);
            }
        }
        if (!audit.auditApproved()) {
            this.auditAttempt(0, true);
            return audit.auditApproved();
        }
        if (!audit.isDeclared()) this.declare(true);
        return false;
    }

    /// @dev Honest handling of a unit that has figures but is not approved.
    function _honest(T.Level level, uint256 u, uint256 seed) internal returns (bool) {
        IPartyAgentVerification.ResultRecord memory r = verification.getRecord(level, u);
        if (r.status == T.ResultStatus.PendingSignatures) {
            for (uint256 p = 1; p <= PARTIES; p++) {
                address a = book.agentAt(level, u, p);
                vm.prank(a);
                try verification.signResult(level, u, r.figuresHash) { calls["sign"]++; } catch { }
            }
            return true;
        }
        PAV.Dispute memory d = verification.getDispute(r.activeDisputeId);
        if (r.status == T.ResultStatus.Frozen) {
            address officer = book.officerAt(level, u);
            if (!d.requiresCorrection) {
                vm.prank(officer);
                try verification.resolveDispute(level, u, d.id, "bafy-res", "ok") { calls["resolve"]++; } catch { }
            } else if (level == T.Level.PollingUnit) {
                T.Figures memory f = _figures(seed ^ 0xC0FFEE);
                vm.prank(officer);
                try upload.resubmitResult(u, f, "bafy-corr") { calls["correct"]++; } catch { }
            } else {
                (T.Figures memory agg,,) = collation.computeAggregate(level, u);
                vm.prank(officer);
                try collation.confirmCollation(level, u, agg, "bafy-corr") { calls["correct"]++; } catch { }
            }
            return true;
        }
        if (r.status == T.ResultStatus.Resolved) {
            vm.prank(d.agent);
            try verification.acceptResolution(d.id) { calls["accept"]++; } catch { }
            return true;
        }
        if (r.status == T.ResultStatus.Escalated) {
            address aud = election.auditor();
            vm.prank(aud);
            try verification.ruleOnEscalation(d.id, false, "bafy-dismiss") { calls["rule"]++; } catch { }
            return true;
        }
        return false;
    }

    // ------------------------------------------------------------------
    // ghost bookkeeping
    // ------------------------------------------------------------------
    function _snapshot() internal {
        for (uint8 l = 0; l < 4; l++) {
            uint256 n = l == 0 ? book.nPu() : l == 1 ? book.nWard() : l == 2 ? book.nLga() : 1;
            for (uint256 u = 1; u <= n; u++) {
                T.Level level = T.Level(l);
                bytes32 k = T.key(level, u);
                if (!ghostWasApproved[k] && verification.isApproved(level, u)) {
                    ghostWasApproved[k] = true;
                    ghostApprovedHash[k] = verification.currentFiguresHash(level, u);
                }
            }
        }
    }
}

/// @notice Handler-based invariant suite over the default fixture geography (2 LGAs x 2 wards x 2 PUs,
///         3 parties) — small enough that random walks regularly reach the state declaration.
contract VoteChainInvariantTest is VoteChainFixture, IActorBook {
    VoteChainHandler internal handler;

    function setUp() public override {
        super.setUp();
        activate();
        handler = new VoteChainHandler(election, upload, verification, collation, audit, this);
        targetContract(address(handler));
    }

    // IActorBook
    function agentAt(T.Level level, uint256 unitId, uint256 party) external view returns (address) {
        return agentOf[uint8(level)][unitId][party];
    }

    function officerAt(T.Level level, uint256 unitId) external view returns (address) {
        return officerFor(level, unitId);
    }

    function auditorKey() external view returns (uint256) {
        return auditorPk;
    }

    function adminAddr() external view returns (address) {
        return admin;
    }

    function publisherAddr() external view returns (address) {
        return publisher;
    }

    function nPu() external view returns (uint256) {
        return puCount;
    }

    function nWard() external view returns (uint256) {
        return wardCount;
    }

    function nLga() external view returns (uint256) {
        return lgaCount;
    }

    function _n(uint8 l) internal view returns (uint256) {
        return l == 0 ? puCount : l == 1 ? wardCount : l == 2 ? lgaCount : 1;
    }

    // ------------------------------------------------------------------
    // Invariants
    // ------------------------------------------------------------------

    /// "A parent level's totals always equal the sum of its approved children."
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 120
    function invariant_parentTotalsEqualSumOfApprovedChildren() public view {
        for (uint8 l = 1; l < 4; l++) {
            for (uint256 u = 1; u <= _n(l); u++) {
                T.Level level = T.Level(l);
                if (!verification.isApproved(level, u)) continue;
                (bool ok,,,,) = collation.verifyConsistency(level, u);
                assertTrue(ok, "approved parent != sum of children");
                (, bool complete,) = collation.computeAggregate(level, u);
                assertTrue(complete, "approved parent has a non-approved child");
            }
        }
    }

    /// "Nothing can be declared without a valid auditor signature over the declared hash."
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 120
    function invariant_noDeclarationWithoutAuditorSignature() public view {
        assertEq(handler.ghostForgedAuditAccepted(), 0, "forged audit accepted");
        if (audit.isDeclared()) {
            AuditDeclaration.AuditRecord memory a = audit.getAudit();
            assertTrue(a.approved);
            assertEq(a.auditor, election.auditor());
            AuditDeclaration.Declaration memory d = audit.getDeclaration();
            assertEq(d.stateResultHash, a.stateResultHash);
            bytes32 digest = keccak256(
                abi.encode("VoteChain.AuditApproval", block.chainid, address(audit), a.stateResultHash)
            );
            assertEq(
                ecrecover2(MessageHashUtils.toEthSignedMessageHash(digest), a.signature), election.auditor()
            );
            assertEq(uint8(election.phase()), uint8(T.Phase.Declared));
            assertEq(uint8(status(T.Level.State, 1)), uint8(T.ResultStatus.Declared));
        }
        if (audit.auditApproved()) {
            assertTrue(verification.isApproved(T.Level.State, 1));
        }
    }

    /// "An approved result is immutable" (status never leaves Approved/Declared; hash never changes).
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 120
    function invariant_approvedResultIsImmutable() public view {
        for (uint8 l = 0; l < 4; l++) {
            for (uint256 u = 1; u <= _n(l); u++) {
                T.Level level = T.Level(l);
                bytes32 k = T.key(level, u);
                if (!handler.ghostWasApproved(k)) continue;
                assertTrue(verification.isApproved(level, u), "approved unit lost approval");
                assertEq(verification.currentFiguresHash(level, u), handler.ghostApprovedHash(k), "hash changed");
            }
        }
    }

    /// n-of-n: approval implies a full signature set; counts never exceed the agent set.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 120
    function invariant_signatureAccounting() public view {
        for (uint8 l = 0; l < 4; l++) {
            for (uint256 u = 1; u <= _n(l); u++) {
                T.Level level = T.Level(l);
                IPAVRecord memory r = _rec(level, u);
                uint256 n = election.agentCount(level, u);
                assertLe(r.signatureCount, n, "more signatures than agents");
                if (verification.isApproved(level, u)) {
                    assertEq(r.signatureCount, n, "approved without n-of-n");
                    assertGt(n, 0);
                }
                bool disputed = r.status == T.ResultStatus.Frozen || r.status == T.ResultStatus.Resolved
                    || r.status == T.ResultStatus.Escalated;
                assertEq(disputed, r.activeDisputeId != 0, "active dispute iff disputed status");
            }
        }
    }

    /// The pendingEscalations counter matches the dispute list; stored hashes match stored figures.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 120
    function invariant_bookkeeping() public view {
        uint256 escalated;
        for (uint256 i = 1; i <= verification.disputeCount(); i++) {
            if (verification.getDispute(i).status == T.DisputeStatus.Escalated) escalated++;
        }
        assertEq(verification.pendingEscalations(), escalated);
        for (uint256 pu = 1; pu <= puCount; pu++) {
            if (!upload.hasResult(pu)) continue;
            ResultUpload.PollingUnitResult memory r = upload.getResult(pu);
            assertEq(r.figuresHash, verification.currentFiguresHash(T.Level.PollingUnit, pu));
            assertEq(r.figuresHash, keccak256(
                abi.encode(T.Level.PollingUnit, pu, r.figures.registeredVoters, r.figures.accreditedVoters,
                    r.figures.totalVotesCast, r.figures.validVotes, r.figures.rejectedVotes,
                    r.figures.candidateVotes, r.formCid)
            ));
            (T.Rule rule,,) = upload.validateFigures(pu, r.figures);
            assertEq(uint8(rule), uint8(T.Rule.None), "stored figures violate Table 3.2");
        }
        assertEq(handler.ghostOutOfScopeSuccess(), 0, "out-of-scope action succeeded");
    }

    /// Diagnostic: shows how far random walks get (printed with -vv).
    function afterInvariant() public {
        emit log_named_uint("submit", handler.calls("submit"));
        emit log_named_uint("sign", handler.calls("sign"));
        emit log_named_uint("dispute", handler.calls("dispute"));
        emit log_named_uint("resolve", handler.calls("resolve"));
        emit log_named_uint("correct", handler.calls("correct"));
        emit log_named_uint("escalate", handler.calls("escalate"));
        emit log_named_uint("rule", handler.calls("rule"));
        emit log_named_uint("collate", handler.calls("collate"));
        emit log_named_uint("audit", handler.calls("audit"));
        emit log_named_uint("declare", handler.calls("declare"));
        emit log_named_uint("mismatchAlerts", handler.ghostMismatchAlerts());
        emit log_named_uint("cancel", handler.calls("cancel"));
        emit log_named_uint("stateApproved", verification.isApproved(T.Level.State, 1) ? 1 : 0);
        emit log_named_uint("declared", audit.isDeclared() ? 1 : 0);
    }

    // ------------------------------------------------------------------
    struct IPAVRecord {
        T.ResultStatus status;
        uint256 signatureCount;
        uint256 activeDisputeId;
    }

    function _rec(T.Level level, uint256 u) internal view returns (IPAVRecord memory x) {
        IPartyAgentVerificationRecord memory r = _raw(level, u);
        x.status = r.status;
        x.signatureCount = r.signatureCount;
        x.activeDisputeId = r.activeDisputeId;
    }

    struct IPartyAgentVerificationRecord {
        T.ResultStatus status;
        uint256 signatureCount;
        uint256 activeDisputeId;
    }

    function _raw(T.Level level, uint256 u) internal view returns (IPartyAgentVerificationRecord memory x) {
        IPartyAgentVerification.ResultRecord memory r = verification.getRecord(level, u);
        x.status = r.status;
        x.signatureCount = r.signatureCount;
        x.activeDisputeId = r.activeDisputeId;
    }

    function ecrecover2(bytes32 digest, bytes memory sig) internal pure returns (address) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        return ecrecover(digest, v, r, s);
    }
}

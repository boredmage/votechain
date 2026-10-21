// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { VoteChainTypes as T } from "./VoteChainTypes.sol";
import { IElectionManager, IPartyAgentVerification } from "./interfaces/IVoteChain.sol";

/// @title PartyAgentVerification
/// @notice Multi-party digital signing at every administrative level plus the on-chain dispute
///         state machine (Sections 3.5.3 and 3.9, Figure 3.3).
///
/// Invariants enforced here:
///  * Approval threshold: a result moves PendingSignatures -> Approved only when EVERY party agent
///    registered at that unit has signed the current round (n-of-n, no majority voting).
///  * Dispute freeze: a dispute moves the result to Frozen immediately; no higher level can
///    incorporate a Frozen/Resolved/Escalated result (CollationEngine checks `isApproved`).
///  * Signature binding: each signature references the keccak256 hash of the exact figures (and
///    form CID) being approved; a signature for a stale hash is rejected.
///  * Every resolution starts a fresh signing round, so all agents re-sign the revised or
///    confirmed figures.
///
/// Deadlock safety: when the disputing agent escalates and the independent auditor dismisses
/// the dispute, that agent's signature slot is waived for the new round (the ruling is recorded
/// permanently on-chain); when the auditor upholds it, the result returns to Frozen and only a
/// corrected-figures resolution is accepted.
contract PartyAgentVerification is IPartyAgentVerification {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------
    struct SignatureRecord {
        bool signed;
        bool objection; // signed under protest (non-blocking objection, Section 3.6)
        bool waived; // slot satisfied by an auditor ruling that dismissed this agent's dispute
        bytes32 figuresHash;
        uint64 timestamp;
        uint256 blockNumber;
        string objectionReason;
    }

    struct Resolution {
        T.ResolutionType kind;
        address resolvedBy;
        string documentCid;
        string note;
        uint64 resolvedAt;
        uint64 acceptedAt;
        uint64 escalatedAt;
    }

    struct Ruling {
        bool upheld;
        string documentCid;
        uint64 ruledAt;
    }

    struct Dispute {
        uint256 id;
        T.Level level;
        uint256 unitId;
        uint32 round;
        address agent;
        uint256 partyId;
        bytes32 disputedFiguresHash;
        string reason;
        string evidenceCid;
        uint64 raisedAt;
        T.DisputeStatus status;
        bool requiresCorrection;
        Resolution resolution;
        Ruling ruling;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------
    IElectionManager public immutable election;

    mapping(bytes32 => ResultRecord) internal _records;
    mapping(bytes32 => mapping(uint32 => mapping(address => SignatureRecord))) internal _signatures;
    mapping(bytes32 => mapping(uint32 => address[])) internal _signers;

    Dispute[] internal _disputes; // id == index + 1
    mapping(bytes32 => uint256[]) internal _disputeIdsOf;
    uint256 public override pendingEscalations;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    event StatusChanged(
        T.Level indexed level, uint256 indexed unitId, T.ResultStatus from, T.ResultStatus to
    );
    event SignatureRoundOpened(
        T.Level indexed level, uint256 indexed unitId, uint32 round, bytes32 figuresHash
    );
    event ResultSigned(
        T.Level indexed level,
        uint256 indexed unitId,
        uint32 round,
        address indexed agent,
        uint256 partyId,
        bytes32 figuresHash,
        bool objection
    );
    event ObjectionRecorded(
        T.Level indexed level,
        uint256 indexed unitId,
        uint32 round,
        address indexed agent,
        uint256 partyId,
        string reason
    );
    event ResultApproved(
        T.Level indexed level, uint256 indexed unitId, uint32 round, uint256 signatures, uint64 timestamp
    );
    event DisputeRaised(
        uint256 indexed disputeId,
        T.Level indexed level,
        uint256 indexed unitId,
        uint32 round,
        address agent,
        uint256 partyId,
        string reason,
        string evidenceCid
    );
    event DisputeResolved(
        uint256 indexed disputeId,
        T.ResolutionType kind,
        address indexed resolvedBy,
        string documentCid,
        uint32 newRound
    );
    event ResolutionAccepted(uint256 indexed disputeId, address indexed agent);
    event DisputeEscalated(uint256 indexed disputeId, address indexed agent);
    event EscalationRuled(
        uint256 indexed disputeId, address indexed auditor, bool upheld, string documentCid
    );
    event SignatureWaived(
        T.Level indexed level, uint256 indexed unitId, uint32 round, address indexed agent, uint256 disputeId
    );

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------
    error NotAgentForUnit(address account, T.Level level, uint256 unitId);
    error NotOfficerForUnit(address account, T.Level level, uint256 unitId);
    error NotDisputingAgent(address account, uint256 disputeId);
    error NotAuditor(address account);
    error AlreadySigned(address account, uint32 round);
    error StaleFiguresHash(bytes32 expected, bytes32 provided);
    error CannotDisputeAfterSigning(address account);
    error EmptyReason();
    error NoActiveDispute(T.Level level, uint256 unitId);
    error WrongDispute(uint256 expected, uint256 provided);
    error InvalidDisputeStatus(uint256 disputeId, T.DisputeStatus current);
    error CorrectionRequired(uint256 disputeId);
    error UnknownDispute(uint256 disputeId);
    error NotOperational(T.Phase phase);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------
    /// @dev Signing/dispute actions are only meaningful while the election is Active or in Collation.
    modifier operational() {
        _requireOperational();
        _;
    }

    modifier onlyModuleFor(T.Level level) {
        _requireModuleFor(level);
        _;
    }

    function _requireOperational() internal view {
        T.Phase p = election.phase();
        if (p != T.Phase.Active && p != T.Phase.Collation) revert NotOperational(p);
    }

    function _requireModuleFor(T.Level level) internal view {
        address expected = level == T.Level.PollingUnit ? election.resultUpload() : election.collationEngine();
        if (msg.sender != expected) revert T.NotAuthorised(msg.sender);
    }

    constructor(address electionManager) {
        election = IElectionManager(electionManager);
    }

    // ---------------------------------------------------------------------
    // Module hooks (ResultUpload / CollationEngine / AuditDeclaration)
    // ---------------------------------------------------------------------
    /// @inheritdoc IPartyAgentVerification
    function openSignatureRound(T.Level level, uint256 unitId, bytes32 figuresHash)
        external
        override
        onlyModuleFor(level)
    {
        bytes32 k = T.key(level, unitId);
        ResultRecord storage r = _records[k];
        if (r.status != T.ResultStatus.Open) revert T.InvalidStatus(level, unitId, r.status);
        r.round = 1;
        r.signatureCount = 0;
        r.figuresHash = figuresHash;
        r.openedAt = uint64(block.timestamp);
        _setStatus(k, level, unitId, T.ResultStatus.PendingSignatures);
        emit SignatureRoundOpened(level, unitId, 1, figuresHash);
        _maybeApprove(k, level, unitId);
    }

    /// @inheritdoc IPartyAgentVerification
    /// @dev Called when the responsible officer corrects the figures of a Frozen result. Acts as a
    ///      FiguresCorrected resolution of the active dispute and opens a new signing round.
    function correctFigures(T.Level level, uint256 unitId, bytes32 newFiguresHash, address officer)
        external
        override
        onlyModuleFor(level)
    {
        bytes32 k = T.key(level, unitId);
        ResultRecord storage r = _records[k];
        if (r.status != T.ResultStatus.Frozen) revert T.InvalidStatus(level, unitId, r.status);
        if (r.activeDisputeId == 0) revert NoActiveDispute(level, unitId);

        Dispute storage d = _disputes[r.activeDisputeId - 1];
        d.status = T.DisputeStatus.Resolved;
        d.requiresCorrection = false;
        d.resolution.kind = T.ResolutionType.FiguresCorrected;
        d.resolution.resolvedBy = officer; // the officer who submitted the corrected figures
        d.resolution.resolvedAt = uint64(block.timestamp);

        r.round += 1;
        r.signatureCount = 0;
        r.figuresHash = newFiguresHash;
        _setStatus(k, level, unitId, T.ResultStatus.Resolved);
        emit DisputeResolved(d.id, T.ResolutionType.FiguresCorrected, officer, "", r.round);
        emit SignatureRoundOpened(level, unitId, r.round, newFiguresHash);
    }

    /// @inheritdoc IPartyAgentVerification
    function markDeclared(T.Level level, uint256 unitId) external override {
        if (msg.sender != election.auditDeclaration()) revert T.NotAuthorised(msg.sender);
        bytes32 k = T.key(level, unitId);
        if (_records[k].status != T.ResultStatus.Approved) {
            revert T.InvalidStatus(level, unitId, _records[k].status);
        }
        _setStatus(k, level, unitId, T.ResultStatus.Declared);
    }

    // ---------------------------------------------------------------------
    // Party-agent actions
    // ---------------------------------------------------------------------
    /// @notice Signs the current figures of a unit. `figuresHash` must equal the on-chain hash so the
    ///         signature is bound to exactly what the agent reviewed.
    function signResult(T.Level level, uint256 unitId, bytes32 figuresHash) external operational {
        _sign(level, unitId, figuresHash, false, "");
    }

    /// @notice Signs while recording a non-blocking objection (figures tally, agent still objects).
    ///         The objection is permanent on-chain evidence but does not stop the collation.
    function signWithObjection(T.Level level, uint256 unitId, bytes32 figuresHash, string calldata reason)
        external
        operational
    {
        if (bytes(reason).length == 0) revert EmptyReason();
        _sign(level, unitId, figuresHash, true, reason);
    }

    /// @notice Raises a formal dispute: the result is frozen until the officer resolves it and every
    ///         agent re-signs the revised or confirmed figures.
    function raiseDispute(T.Level level, uint256 unitId, string calldata reason, string calldata evidenceCid)
        external
        operational
        returns (uint256 disputeId)
    {
        if (bytes(reason).length == 0) revert EmptyReason();
        (bool ok, uint256 partyId) = election.isAgentFor(level, unitId, msg.sender);
        if (!ok) revert NotAgentForUnit(msg.sender, level, unitId);

        bytes32 k = T.key(level, unitId);
        ResultRecord storage r = _records[k];
        if (r.status != T.ResultStatus.PendingSignatures) revert T.InvalidStatus(level, unitId, r.status);
        if (_signatures[k][r.round][msg.sender].signed) revert CannotDisputeAfterSigning(msg.sender);

        disputeId = _createDispute(k, level, unitId, partyId, reason, evidenceCid);
        r.activeDisputeId = disputeId;
        _setStatus(k, level, unitId, T.ResultStatus.Frozen);
    }

    function _createDispute(
        bytes32 k,
        T.Level level,
        uint256 unitId,
        uint256 partyId,
        string calldata reason,
        string calldata evidenceCid
    ) internal returns (uint256 disputeId) {
        ResultRecord storage r = _records[k];
        disputeId = _disputes.length + 1;
        Dispute storage d = _disputes.push();
        d.id = disputeId;
        d.level = level;
        d.unitId = unitId;
        d.round = r.round;
        d.agent = msg.sender;
        d.partyId = partyId;
        d.disputedFiguresHash = r.figuresHash;
        d.reason = reason;
        d.evidenceCid = evidenceCid;
        d.raisedAt = uint64(block.timestamp);
        d.status = T.DisputeStatus.Raised;
        _disputeIdsOf[k].push(disputeId);
        emit DisputeRaised(disputeId, level, unitId, r.round, msg.sender, partyId, reason, evidenceCid);
    }

    /// @notice Officer resolution confirming that the original figures are correct (documented on IPFS).
    ///         Corrections are made instead through ResultUpload.resubmitResult / CollationEngine.confirmCollation.
    function resolveDispute(
        T.Level level,
        uint256 unitId,
        uint256 disputeId,
        string calldata documentCid,
        string calldata note
    ) external operational {
        if (!election.isOfficerFor(level, unitId, msg.sender)) {
            revert NotOfficerForUnit(msg.sender, level, unitId);
        }
        bytes32 k = T.key(level, unitId);
        ResultRecord storage r = _records[k];
        if (r.status != T.ResultStatus.Frozen) revert T.InvalidStatus(level, unitId, r.status);
        if (r.activeDisputeId != disputeId) revert WrongDispute(r.activeDisputeId, disputeId);

        Dispute storage d = _disputes[disputeId - 1];
        if (d.requiresCorrection) revert CorrectionRequired(disputeId);

        d.status = T.DisputeStatus.Resolved;
        d.resolution.kind = T.ResolutionType.ConfirmedOriginal;
        d.resolution.resolvedBy = msg.sender;
        d.resolution.documentCid = documentCid;
        d.resolution.note = note;
        d.resolution.resolvedAt = uint64(block.timestamp);

        // Confirmed figures must be re-signed by every agent: start a new round with the same hash.
        r.round += 1;
        r.signatureCount = 0;
        _setStatus(k, level, unitId, T.ResultStatus.Resolved);
        emit DisputeResolved(disputeId, T.ResolutionType.ConfirmedOriginal, msg.sender, documentCid, r.round);
        emit SignatureRoundOpened(level, unitId, r.round, r.figuresHash);
    }

    /// @notice The disputing agent accepts the officer's resolution; signing re-opens for all agents.
    function acceptResolution(uint256 disputeId) external operational {
        Dispute storage d = _dispute(disputeId);
        if (d.agent != msg.sender) revert NotDisputingAgent(msg.sender, disputeId);
        if (d.status != T.DisputeStatus.Resolved) revert InvalidDisputeStatus(disputeId, d.status);

        bytes32 k = T.key(d.level, d.unitId);
        ResultRecord storage r = _records[k];
        d.status = T.DisputeStatus.Accepted;
        d.resolution.acceptedAt = uint64(block.timestamp);
        r.activeDisputeId = 0;
        _setStatus(k, d.level, d.unitId, T.ResultStatus.PendingSignatures);
        emit ResolutionAccepted(disputeId, msg.sender);
        _maybeApprove(k, d.level, d.unitId);
    }

    /// @notice The disputing agent rejects the resolution and escalates to the independent auditor.
    function escalateDispute(uint256 disputeId) external operational {
        Dispute storage d = _dispute(disputeId);
        if (d.agent != msg.sender) revert NotDisputingAgent(msg.sender, disputeId);
        if (d.status != T.DisputeStatus.Resolved) revert InvalidDisputeStatus(disputeId, d.status);

        d.status = T.DisputeStatus.Escalated;
        d.resolution.escalatedAt = uint64(block.timestamp);
        pendingEscalations += 1;
        _setStatus(T.key(d.level, d.unitId), d.level, d.unitId, T.ResultStatus.Escalated);
        emit DisputeEscalated(disputeId, msg.sender);
    }

    /// @notice The independent auditor rules on an escalated dispute.
    /// @param upheld true  -> the dispute has merit: result returns to Frozen and only a corrected-figures
    ///                        resolution is accepted from the officer;
    ///               false -> dispute dismissed: the disputing agent's signature slot is waived for the
    ///                        new round and signing continues for the remaining agents.
    function ruleOnEscalation(uint256 disputeId, bool upheld, string calldata documentCid)
        external
        operational
    {
        if (msg.sender != election.auditor()) revert NotAuditor(msg.sender);
        Dispute storage d = _dispute(disputeId);
        if (d.status != T.DisputeStatus.Escalated) revert InvalidDisputeStatus(disputeId, d.status);

        bytes32 k = T.key(d.level, d.unitId);
        ResultRecord storage r = _records[k];
        pendingEscalations -= 1;
        d.ruling = Ruling({ upheld: upheld, documentCid: documentCid, ruledAt: uint64(block.timestamp) });
        emit EscalationRuled(disputeId, msg.sender, upheld, documentCid);

        if (upheld) {
            d.status = T.DisputeStatus.RuledUpheld;
            d.requiresCorrection = true;
            _setStatus(k, d.level, d.unitId, T.ResultStatus.Frozen);
        } else {
            d.status = T.DisputeStatus.RuledDismissed;
            r.activeDisputeId = 0;
            SignatureRecord storage s = _signatures[k][r.round][d.agent];
            if (!s.signed && !s.waived) {
                s.waived = true;
                s.timestamp = uint64(block.timestamp);
                s.blockNumber = block.number;
                r.signatureCount += 1;
                emit SignatureWaived(d.level, d.unitId, r.round, d.agent, disputeId);
            }
            _setStatus(k, d.level, d.unitId, T.ResultStatus.PendingSignatures);
            _maybeApprove(k, d.level, d.unitId);
        }
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------
    function _sign(T.Level level, uint256 unitId, bytes32 figuresHash, bool objection, string memory reason)
        internal
    {
        (bool ok, uint256 partyId) = election.isAgentFor(level, unitId, msg.sender);
        if (!ok) revert NotAgentForUnit(msg.sender, level, unitId);

        bytes32 k = T.key(level, unitId);
        ResultRecord storage r = _records[k];
        if (r.status != T.ResultStatus.PendingSignatures) revert T.InvalidStatus(level, unitId, r.status);
        if (r.figuresHash != figuresHash) revert StaleFiguresHash(r.figuresHash, figuresHash);

        SignatureRecord storage s = _signatures[k][r.round][msg.sender];
        if (s.signed) revert AlreadySigned(msg.sender, r.round);

        bool alreadyCounted = s.waived;
        s.signed = true;
        s.objection = objection;
        s.figuresHash = figuresHash;
        s.timestamp = uint64(block.timestamp);
        s.blockNumber = block.number;
        s.objectionReason = reason;
        _signers[k][r.round].push(msg.sender);
        if (!alreadyCounted) r.signatureCount += 1;

        emit ResultSigned(level, unitId, r.round, msg.sender, partyId, figuresHash, objection);
        if (objection) emit ObjectionRecorded(level, unitId, r.round, msg.sender, partyId, reason);
        _maybeApprove(k, level, unitId);
    }

    /// @dev n-of-n threshold: approve when every registered agent at the unit has signed (or been waived).
    function _maybeApprove(bytes32 k, T.Level level, uint256 unitId) internal {
        ResultRecord storage r = _records[k];
        if (r.status != T.ResultStatus.PendingSignatures) return;
        uint256 required = election.agentCount(level, unitId);
        if (required == 0) return; // no accredited agents: cannot be approved (documented limitation)
        if (r.signatureCount >= required) {
            r.approvedAt = uint64(block.timestamp);
            _setStatus(k, level, unitId, T.ResultStatus.Approved);
            emit ResultApproved(level, unitId, r.round, r.signatureCount, uint64(block.timestamp));
        }
    }

    function _setStatus(bytes32 k, T.Level level, uint256 unitId, T.ResultStatus to) internal {
        T.ResultStatus from = _records[k].status;
        _records[k].status = to;
        emit StatusChanged(level, unitId, from, to);
    }

    function _dispute(uint256 disputeId) internal view returns (Dispute storage) {
        if (disputeId == 0 || disputeId > _disputes.length) revert UnknownDispute(disputeId);
        return _disputes[disputeId - 1];
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------
    function statusOf(T.Level level, uint256 unitId) public view override returns (T.ResultStatus) {
        return _records[T.key(level, unitId)].status;
    }

    function isApproved(T.Level level, uint256 unitId) external view override returns (bool) {
        T.ResultStatus s = statusOf(level, unitId);
        return s == T.ResultStatus.Approved || s == T.ResultStatus.Declared;
    }

    function currentFiguresHash(T.Level level, uint256 unitId) external view override returns (bytes32) {
        return _records[T.key(level, unitId)].figuresHash;
    }

    function getRecord(T.Level level, uint256 unitId) external view override returns (ResultRecord memory) {
        return _records[T.key(level, unitId)];
    }

    function requiredSignatures(T.Level level, uint256 unitId) external view returns (uint256) {
        return election.agentCount(level, unitId);
    }

    function getSignature(T.Level level, uint256 unitId, uint32 round, address agent)
        external
        view
        returns (SignatureRecord memory)
    {
        return _signatures[T.key(level, unitId)][round][agent];
    }

    function signersOf(T.Level level, uint256 unitId, uint32 round) external view returns (address[] memory) {
        return _signers[T.key(level, unitId)][round];
    }

    /// @notice Signing progress for the current round: registered agents and whether each has signed.
    function signingProgress(T.Level level, uint256 unitId)
        external
        view
        returns (
            address[] memory agents,
            bool[] memory signed,
            bool[] memory objections,
            bool[] memory waived
        )
    {
        bytes32 k = T.key(level, unitId);
        uint32 round = _records[k].round;
        agents = election.agentsOf(level, unitId);
        signed = new bool[](agents.length);
        objections = new bool[](agents.length);
        waived = new bool[](agents.length);
        for (uint256 i = 0; i < agents.length; i++) {
            SignatureRecord storage s = _signatures[k][round][agents[i]];
            signed[i] = s.signed;
            objections[i] = s.objection;
            waived[i] = s.waived;
        }
    }

    function disputeCount() external view returns (uint256) {
        return _disputes.length;
    }

    function getDispute(uint256 disputeId) external view returns (Dispute memory) {
        return _dispute(disputeId);
    }

    function disputeIdsOf(T.Level level, uint256 unitId) external view returns (uint256[] memory) {
        return _disputeIdsOf[T.key(level, unitId)];
    }

    /// @notice Disputes currently awaiting an auditor ruling.
    function escalatedDisputeIds() external view override returns (uint256[] memory ids) {
        ids = new uint256[](pendingEscalations);
        uint256 n;
        for (uint256 i = 0; i < _disputes.length && n < pendingEscalations; i++) {
            if (_disputes[i].status == T.DisputeStatus.Escalated) ids[n++] = _disputes[i].id;
        }
    }
}

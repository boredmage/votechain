// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { VoteChainTypes as T } from "./VoteChainTypes.sol";
import { IElectionManager, IPartyAgentVerification, IResultUpload } from "./interfaces/IVoteChain.sol";

/// @title ResultUpload
/// @notice Polling-unit (EC8A) result submission (Section 3.5.2). A presiding officer submits the
///         figures for their own polling unit together with the IPFS CID of the scanned form.
///         All arithmetic checks of Table 3.2 run atomically in `validateFigures`; any violation
///         reverts the whole transaction with a specific error naming the rule, the expected bound
///         and the offending value. On success the figures, the form CID, the block number and the
///         timestamp are stored, `ResultSubmitted` is emitted (notifying the registered party
///         agents) and the unit moves from Open to PendingSignatures.
contract ResultUpload is IResultUpload {
    struct PollingUnitResult {
        bool exists;
        uint32 round; // increments on every (re)submission
        T.Figures figures;
        string formCid; // IPFS CID of the scanned EC8A form
        address officer;
        uint64 submittedAt;
        uint256 blockNumber;
        bytes32 figuresHash;
    }

    IElectionManager public immutable election;
    IPartyAgentVerification public immutable verification;

    mapping(uint256 => PollingUnitResult) internal _results;
    uint256 public submissionCount;

    event ResultSubmitted(
        uint256 indexed puId,
        uint32 round,
        address indexed officer,
        bytes32 figuresHash,
        string formCid,
        uint256 blockNumber,
        uint64 timestamp
    );
    event ResultResubmitted(
        uint256 indexed puId,
        uint32 round,
        address indexed officer,
        bytes32 figuresHash,
        string formCid,
        uint64 timestamp
    );

    error ValidationFailed(T.Rule rule, uint256 expected, uint256 actual);
    error NotPresidingOfficer(address account, uint256 puId);
    error PollingUnitCancelled(uint256 puId);
    error EmptyFormCid();

    constructor(address electionManager, address partyAgentVerification) {
        election = IElectionManager(electionManager);
        verification = IPartyAgentVerification(partyAgentVerification);
    }

    // ---------------------------------------------------------------------
    // Submission
    // ---------------------------------------------------------------------
    /// @notice First-time submission of a polling unit's figures. Only during the Active phase.
    function submitResult(uint256 puId, T.Figures calldata figures, string calldata formCid) external {
        T.Phase p = election.phase();
        if (p != T.Phase.Active) revert T.WrongPhase(p, T.Phase.Active);
        _checkOfficer(puId);
        if (verification.statusOf(T.Level.PollingUnit, puId) != T.ResultStatus.Open) {
            revert T.InvalidStatus(
                T.Level.PollingUnit, puId, verification.statusOf(T.Level.PollingUnit, puId)
            );
        }
        bytes32 h = _store(puId, figures, formCid, 1);
        verification.openSignatureRound(T.Level.PollingUnit, puId, h);
        emit ResultSubmitted(puId, 1, msg.sender, h, formCid, block.number, uint64(block.timestamp));
    }

    /// @notice Corrected submission while the unit is Frozen by a dispute. Runs the same checks and
    ///         opens a fresh signing round through PartyAgentVerification.correctFigures.
    function resubmitResult(uint256 puId, T.Figures calldata figures, string calldata formCid) external {
        T.Phase p = election.phase();
        if (p != T.Phase.Active && p != T.Phase.Collation) revert T.WrongPhase(p, T.Phase.Active);
        _checkOfficer(puId);
        T.ResultStatus s = verification.statusOf(T.Level.PollingUnit, puId);
        if (s != T.ResultStatus.Frozen) revert T.InvalidStatus(T.Level.PollingUnit, puId, s);
        uint32 round = _results[puId].round + 1;
        bytes32 h = _store(puId, figures, formCid, round);
        verification.correctFigures(T.Level.PollingUnit, puId, h, msg.sender);
        emit ResultResubmitted(puId, round, msg.sender, h, formCid, uint64(block.timestamp));
    }

    function _checkOfficer(uint256 puId) internal view {
        if (!election.unitExists(T.Level.PollingUnit, puId)) revert T.UnknownUnit(T.Level.PollingUnit, puId);
        if (election.presidingOfficerOf(puId) != msg.sender) revert NotPresidingOfficer(msg.sender, puId);
        if (election.isPollingUnitCancelled(puId)) revert PollingUnitCancelled(puId);
    }

    function _store(uint256 puId, T.Figures calldata figures, string calldata formCid, uint32 round)
        internal
        returns (bytes32 h)
    {
        if (bytes(formCid).length == 0) revert EmptyFormCid();
        (T.Rule rule, uint256 expected, uint256 actual) = validateFigures(puId, figures);
        if (rule != T.Rule.None) revert ValidationFailed(rule, expected, actual);

        PollingUnitResult storage r = _results[puId];
        r.exists = true;
        r.round = round;
        r.figures = figures;
        r.formCid = formCid;
        r.officer = msg.sender;
        r.submittedAt = uint64(block.timestamp);
        r.blockNumber = block.number;
        h = T.figuresHash(T.Level.PollingUnit, puId, figures, formCid);
        r.figuresHash = h;
        submissionCount += 1;
    }

    // ---------------------------------------------------------------------
    // Validation (also callable by the portals for instant feedback before sending a transaction)
    // ---------------------------------------------------------------------
    /// @notice Runs rules 1-5 of Table 3.2 plus the INEC register cross-check for `puId`.
    /// @return rule Rule.None when consistent, otherwise the first violated rule.
    /// @return expected The bound the figure had to satisfy.
    /// @return actual The offending figure.
    function validateFigures(uint256 puId, T.Figures memory figures)
        public
        view
        returns (T.Rule rule, uint256 expected, uint256 actual)
    {
        (rule, expected, actual) = T.checkFigures(figures, election.candidateCount());
        if (rule != T.Rule.None) return (rule, expected, actual);
        uint256 registered = election.registeredVotersOf(puId);
        if (registered != 0 && figures.registeredVoters != registered) {
            return (T.Rule.RegisterMismatch, registered, figures.registeredVoters);
        }
        return (T.Rule.None, 0, 0);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------
    function getResult(uint256 puId) external view returns (PollingUnitResult memory) {
        return _results[puId];
    }

    function getFigures(uint256 puId) external view override returns (T.Figures memory) {
        return _results[puId].figures;
    }

    function figuresHashOf(uint256 puId) external view override returns (bytes32) {
        return _results[puId].figuresHash;
    }

    function hasResult(uint256 puId) external view returns (bool) {
        return _results[puId].exists;
    }
}

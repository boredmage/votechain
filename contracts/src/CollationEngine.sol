// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { VoteChainTypes as T } from "./VoteChainTypes.sol";
import {
    IElectionManager,
    IPartyAgentVerification,
    IResultUpload,
    ICollationEngine
} from "./interfaces/IVoteChain.sol";

/// @title CollationEngine
/// @notice Hierarchical aggregation from polling units through wards and LGAs to the state level
///         (Section 3.5.4, Figure 3.2). For each level the engine sums the *approved* results of the
///         level immediately below across all six numeric fields and requires the collation officer's
///         declared totals (the EC8B/EC8C/EC8D form) to match that sum exactly (zero tolerance).
///
///         A mismatch does not silently fail: it is recorded on-chain as a `MismatchAlert` (evidence
///         of an attempted or erroneous alteration), the attempt counter is incremented and the
///         collation stays blocked. No level can be skipped because each level only reads the
///         level directly below it, and only results in Approved status are ever summed.
contract CollationEngine is ICollationEngine {
    struct CollationRecord {
        bool exists;
        uint32 round;
        T.Figures figures;
        string formCid; // EC8B / EC8C / EC8D scan on IPFS
        address officer;
        uint64 confirmedAt;
        uint256 blockNumber;
        bytes32 figuresHash;
        uint32 mismatchAttempts;
    }

    IElectionManager public immutable election;
    IPartyAgentVerification public immutable verification;
    IResultUpload public immutable resultUpload;

    mapping(bytes32 => CollationRecord) internal _records;

    event CollationConfirmed(
        T.Level indexed level,
        uint256 indexed unitId,
        uint32 round,
        address indexed officer,
        bytes32 figuresHash,
        string formCid,
        uint64 timestamp
    );
    event MismatchAlert(
        T.Level indexed level,
        uint256 indexed unitId,
        address indexed officer,
        T.Field field,
        uint256 candidateIndex,
        uint256 declared,
        uint256 computed,
        uint32 attempt
    );

    error NotCollationOfficer(address account, T.Level level, uint256 unitId);
    error InvalidCollationLevel(T.Level level);
    error LowerLevelNotApproved(T.Level lowerLevel, uint256 unitId, T.ResultStatus status);
    error EmptyFormCid();
    error NotOperational(T.Phase phase);

    constructor(address electionManager, address partyAgentVerification, address resultUpload_) {
        election = IElectionManager(electionManager);
        verification = IPartyAgentVerification(partyAgentVerification);
        resultUpload = IResultUpload(resultUpload_);
    }

    // ---------------------------------------------------------------------
    // Aggregation
    // ---------------------------------------------------------------------
    /// @notice Computes the aggregate of the level below `level` for `unitId`.
    /// @return agg            Field-by-field sum of every approved lower-level result.
    /// @return complete       False when at least one lower-level result is not yet Approved.
    /// @return blockingUnitId The first lower-level unit that is not Approved (0 when complete).
    function computeAggregate(T.Level level, uint256 unitId)
        public
        view
        returns (T.Figures memory agg, bool complete, uint256 blockingUnitId)
    {
        uint256 n = election.candidateCount();
        agg = T.emptyFigures(n);
        complete = true;

        if (level == T.Level.Ward) {
            uint256[] memory pus = election.pollingUnitIdsOf(unitId);
            for (uint256 i = 0; i < pus.length; i++) {
                if (election.isPollingUnitCancelled(pus[i])) continue;
                if (!verification.isApproved(T.Level.PollingUnit, pus[i])) return (agg, false, pus[i]);
                T.addInto(agg, resultUpload.getFigures(pus[i]));
            }
        } else if (level == T.Level.LGA) {
            uint256[] memory wards = election.wardIdsOf(unitId);
            for (uint256 i = 0; i < wards.length; i++) {
                if (!verification.isApproved(T.Level.Ward, wards[i])) return (agg, false, wards[i]);
                T.addInto(agg, _records[T.key(T.Level.Ward, wards[i])].figures);
            }
        } else if (level == T.Level.State) {
            uint256 lgas = election.lgaCount();
            for (uint256 i = 1; i <= lgas; i++) {
                if (!verification.isApproved(T.Level.LGA, i)) return (agg, false, i);
                T.addInto(agg, _records[T.key(T.Level.LGA, i)].figures);
            }
        } else {
            revert InvalidCollationLevel(level);
        }
    }

    /// @notice The collation officer confirms the aggregated result of `unitId` by declaring the totals
    ///         written on the physical EC8B/EC8C/EC8D form plus the form's IPFS CID.
    /// @dev    Status Open  -> first confirmation (opens signing round 1).
    ///         Status Frozen -> correction of a disputed collation (new signing round via correctFigures).
    /// @return matched True when the declared totals equal the computed aggregate and the collation was
    ///                 recorded; false when a mismatch alert was recorded and the collation stays blocked.
    function confirmCollation(
        T.Level level,
        uint256 unitId,
        T.Figures calldata declared,
        string calldata formCid
    ) external returns (bool matched) {
        _checkConfirmCaller(level, unitId, formCid);

        T.ResultStatus status = verification.statusOf(level, unitId);
        if (status != T.ResultStatus.Open && status != T.ResultStatus.Frozen) {
            revert T.InvalidStatus(level, unitId, status);
        }

        T.Figures memory agg = _requireCompleteAggregate(level, unitId);
        if (!_matchOrAlert(level, unitId, declared, agg)) return false;

        _record(level, unitId, declared, formCid, status);
        return true;
    }

    function _checkConfirmCaller(T.Level level, uint256 unitId, string calldata formCid) internal view {
        T.Phase p = election.phase();
        if (p != T.Phase.Active && p != T.Phase.Collation) revert NotOperational(p);
        if (level == T.Level.PollingUnit) revert InvalidCollationLevel(level);
        if (!election.unitExists(level, unitId)) revert T.UnknownUnit(level, unitId);
        if (!election.isOfficerFor(level, unitId, msg.sender)) {
            revert NotCollationOfficer(msg.sender, level, unitId);
        }
        if (bytes(formCid).length == 0) revert EmptyFormCid();
    }

    function _requireCompleteAggregate(T.Level level, uint256 unitId)
        internal
        view
        returns (T.Figures memory agg)
    {
        bool complete;
        uint256 blocking;
        (agg, complete, blocking) = computeAggregate(level, unitId);
        if (!complete) {
            T.Level lower = T.Level(uint8(level) - 1);
            revert LowerLevelNotApproved(lower, blocking, verification.statusOf(lower, blocking));
        }
    }

    /// @dev Records a MismatchAlert and returns false when the declared totals differ from the aggregate.
    function _matchOrAlert(T.Level level, uint256 unitId, T.Figures calldata declared, T.Figures memory agg)
        internal
        returns (bool)
    {
        (bool ok, T.Field field, uint256 candidateIndex, uint256 dv, uint256 cv) = _compare(declared, agg);
        if (ok) return true;
        CollationRecord storage rec = _records[T.key(level, unitId)];
        rec.mismatchAttempts += 1;
        emit MismatchAlert(level, unitId, msg.sender, field, candidateIndex, dv, cv, rec.mismatchAttempts);
        return false;
    }

    function _record(
        T.Level level,
        uint256 unitId,
        T.Figures calldata declared,
        string calldata formCid,
        T.ResultStatus status
    ) internal {
        CollationRecord storage rec = _records[T.key(level, unitId)];
        uint32 round = status == T.ResultStatus.Open ? 1 : rec.round + 1;
        rec.exists = true;
        rec.round = round;
        rec.figures = declared;
        rec.formCid = formCid;
        rec.officer = msg.sender;
        rec.confirmedAt = uint64(block.timestamp);
        rec.blockNumber = block.number;
        bytes32 h = T.figuresHash(level, unitId, declared, formCid);
        rec.figuresHash = h;

        if (status == T.ResultStatus.Open) {
            verification.openSignatureRound(level, unitId, h);
        } else {
            verification.correctFigures(level, unitId, h, msg.sender);
        }
        emit CollationConfirmed(level, unitId, round, msg.sender, h, formCid, uint64(block.timestamp));
    }

    /// @notice Non-mutating pre-check used by the portals before sending a confirmation transaction.
    function checkDeclared(T.Level level, uint256 unitId, T.Figures calldata declared)
        external
        view
        returns (bool ok, T.Field field, uint256 candidateIndex, uint256 declaredValue, uint256 computedValue)
    {
        T.Figures memory agg = _requireCompleteAggregate(level, unitId);
        return _compare(declared, agg);
    }

    /// @notice Public verifiability (Section 6.5): recomputes the aggregate of a confirmed collation
    ///         from the stored lower-level records and reports whether it still matches. Anyone can call it.
    function verifyConsistency(T.Level level, uint256 unitId)
        external
        view
        returns (bool consistent, T.Field field, uint256 candidateIndex, uint256 stored, uint256 computed)
    {
        CollationRecord storage rec = _records[T.key(level, unitId)];
        if (!rec.exists) return (false, T.Field.RegisteredVoters, 0, 0, 0);
        (T.Figures memory agg, bool complete,) = computeAggregate(level, unitId);
        if (!complete) return (false, T.Field.RegisteredVoters, 0, 0, 0);
        return _compare(rec.figures, agg);
    }

    function _compare(T.Figures memory declared, T.Figures memory agg)
        internal
        pure
        returns (bool ok, T.Field field, uint256 candidateIndex, uint256 dv, uint256 cv)
    {
        if (declared.registeredVoters != agg.registeredVoters) {
            return (false, T.Field.RegisteredVoters, 0, declared.registeredVoters, agg.registeredVoters);
        }
        if (declared.accreditedVoters != agg.accreditedVoters) {
            return (false, T.Field.AccreditedVoters, 0, declared.accreditedVoters, agg.accreditedVoters);
        }
        if (declared.totalVotesCast != agg.totalVotesCast) {
            return (false, T.Field.TotalVotesCast, 0, declared.totalVotesCast, agg.totalVotesCast);
        }
        if (declared.validVotes != agg.validVotes) {
            return (false, T.Field.ValidVotes, 0, declared.validVotes, agg.validVotes);
        }
        if (declared.rejectedVotes != agg.rejectedVotes) {
            return (false, T.Field.RejectedVotes, 0, declared.rejectedVotes, agg.rejectedVotes);
        }
        if (declared.candidateVotes.length != agg.candidateVotes.length) {
            return
                (false, T.Field.CandidateVotes, 0, declared.candidateVotes.length, agg.candidateVotes.length);
        }
        for (uint256 i = 0; i < agg.candidateVotes.length; i++) {
            if (declared.candidateVotes[i] != agg.candidateVotes[i]) {
                return (false, T.Field.CandidateVotes, i, declared.candidateVotes[i], agg.candidateVotes[i]);
            }
        }
        return (true, T.Field.RegisteredVoters, 0, 0, 0);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------
    function getCollation(T.Level level, uint256 unitId) external view returns (CollationRecord memory) {
        return _records[T.key(level, unitId)];
    }

    function getFigures(T.Level level, uint256 unitId) external view override returns (T.Figures memory) {
        return _records[T.key(level, unitId)].figures;
    }

    function figuresHashOf(T.Level level, uint256 unitId) external view override returns (bytes32) {
        return _records[T.key(level, unitId)].figuresHash;
    }

    function mismatchAttemptsOf(T.Level level, uint256 unitId) external view returns (uint32) {
        return _records[T.key(level, unitId)].mismatchAttempts;
    }
}

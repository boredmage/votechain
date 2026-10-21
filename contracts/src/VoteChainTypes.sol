// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title VoteChainTypes
/// @notice Shared enums, structs, errors and helpers used by every VoteChain module.
/// @dev Kept in one file so that the five contracts, the tests and the off-chain
///      layers (backend indexer, React portals) share a single vocabulary.
library VoteChainTypes {
    // ---------------------------------------------------------------------
    // Administrative hierarchy (Oyo State case study: PU -> Ward -> LGA -> State)
    // ---------------------------------------------------------------------
    enum Level {
        PollingUnit, // EC8A
        Ward, // EC8B
        LGA, // EC8C
        State // EC8D
    }

    /// @notice Unit id used for the single state-level result record.
    uint256 internal constant STATE_UNIT_ID = 1;

    // ---------------------------------------------------------------------
    // Election lifecycle (ElectionManager) – Section 3.5.1
    // ---------------------------------------------------------------------
    enum Phase {
        Registration, // INEC configures geography, candidates and stakeholders
        Active, // polling-unit uploads, signing, disputes and collation allowed
        Collation, // upload window closed; collation + dispute handling only
        Declared // final result declared by the publisher after audit
    }

    // ---------------------------------------------------------------------
    // Result / dispute state machine (Figure 3.3)
    // ---------------------------------------------------------------------
    enum ResultStatus {
        Open, // no figures yet (PU: awaiting EC8A upload; Ward/LGA/State: awaiting officer confirmation)
        PendingSignatures, // figures on-chain, awaiting all party-agent signatures
        Frozen, // a party agent raised a dispute; nothing above can incorporate this result
        Resolved, // officer resolved the dispute; disputing agent must accept or escalate
        Escalated, // disputing agent escalated to the independent auditor
        Approved, // every registered party agent signed the current round
        Declared // (state level only) final declaration recorded
    }

    enum DisputeStatus {
        Raised,
        Resolved,
        Accepted,
        Escalated,
        RuledDismissed,
        RuledUpheld
    }

    enum ResolutionType {
        None,
        ConfirmedOriginal, // officer documented that the original figures are correct
        FiguresCorrected // officer/presiding officer corrected the figures (new signing round)
    }

    // ---------------------------------------------------------------------
    // Mathematical validation rules (Table 3.2)
    // ---------------------------------------------------------------------
    enum Rule {
        None,
        CastExceedsAccredited, // Rule 1: total votes cast > accredited voters
        CastExceedsRegistered, // Rule 2: total votes cast > registered voters
        ValidPlusRejectedMismatch, // Rule 3: valid + rejected != total cast
        CandidateSumMismatch, // Rule 4: sum of candidate votes != valid votes
        AccreditedExceedsRegistered, // Rule 5: accredited voters > registered voters
        CollationMismatch, // Rule 6: collated total != sum of lower-level results
        RegisterMismatch // Register cross-check: registered voters != INEC PU register
    }

    /// @notice Numeric field identifiers used in mismatch alerts.
    enum Field {
        RegisteredVoters,
        AccreditedVoters,
        TotalVotesCast,
        ValidVotes,
        RejectedVotes,
        CandidateVotes // the field index is reported separately (candidateIndex)
    }

    // ---------------------------------------------------------------------
    // Result figures (identical shape at every level)
    // ---------------------------------------------------------------------
    struct Figures {
        uint256 registeredVoters;
        uint256 accreditedVoters;
        uint256 totalVotesCast;
        uint256 validVotes;
        uint256 rejectedVotes;
        uint256[] candidateVotes; // index = candidate index in ElectionManager
    }

    // ---------------------------------------------------------------------
    // Errors shared by several modules
    // ---------------------------------------------------------------------
    error NotAuthorised(address caller);
    error WrongPhase(Phase current, Phase required);
    error UnknownUnit(Level level, uint256 unitId);
    error InvalidStatus(Level level, uint256 unitId, ResultStatus current);

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------
    function key(Level level, uint256 unitId) internal pure returns (bytes32) {
        return keccak256(abi.encode(level, unitId));
    }

    /// @notice Deterministic hash binding a set of figures (and the scanned form CID)
    ///         to a level and unit. Party-agent signatures reference this hash so each
    ///         signature is cryptographically tied to the exact figures reviewed.
    function figuresHash(Level level, uint256 unitId, Figures memory f, string memory formCid)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                level,
                unitId,
                f.registeredVoters,
                f.accreditedVoters,
                f.totalVotesCast,
                f.validVotes,
                f.rejectedVotes,
                f.candidateVotes,
                formCid
            )
        );
    }

    /// @notice Runs the six arithmetic checks of Table 3.2 (rules 1-5 apply to a single set of
    ///         figures; rule 6 is enforced by CollationEngine when aggregates are declared).
    /// @return rule      Rule.None when the figures are consistent, otherwise the violated rule.
    /// @return expected  The bound/expected value for the violated rule (0 when none).
    /// @return actual    The offending value (0 when none).
    function checkFigures(Figures memory f, uint256 candidateCount)
        internal
        pure
        returns (Rule rule, uint256 expected, uint256 actual)
    {
        if (f.candidateVotes.length != candidateCount) {
            return (Rule.CandidateSumMismatch, candidateCount, f.candidateVotes.length);
        }
        // Rules are evaluated in the order of Table 3.2 so each violation is reported by its own rule.
        // Rule 1: total votes cast > accredited voters
        if (f.totalVotesCast > f.accreditedVoters) {
            return (Rule.CastExceedsAccredited, f.accreditedVoters, f.totalVotesCast);
        }
        // Rule 2: total votes cast > registered voters
        if (f.totalVotesCast > f.registeredVoters) {
            return (Rule.CastExceedsRegistered, f.registeredVoters, f.totalVotesCast);
        }
        // Rule 3: valid + rejected != total cast
        if (f.validVotes + f.rejectedVotes != f.totalVotesCast) {
            return (Rule.ValidPlusRejectedMismatch, f.totalVotesCast, f.validVotes + f.rejectedVotes);
        }
        // Rule 4: sum of candidate votes != valid votes
        uint256 sum;
        for (uint256 i = 0; i < f.candidateVotes.length; i++) {
            sum += f.candidateVotes[i];
        }
        if (sum != f.validVotes) {
            return (Rule.CandidateSumMismatch, f.validVotes, sum);
        }
        // Rule 5: accredited voters > registered voters
        if (f.accreditedVoters > f.registeredVoters) {
            return (Rule.AccreditedExceedsRegistered, f.registeredVoters, f.accreditedVoters);
        }
        return (Rule.None, 0, 0);
    }

    /// @notice Adds `b` into `a` field by field (used for hierarchical aggregation).
    function addInto(Figures memory a, Figures memory b) internal pure {
        a.registeredVoters += b.registeredVoters;
        a.accreditedVoters += b.accreditedVoters;
        a.totalVotesCast += b.totalVotesCast;
        a.validVotes += b.validVotes;
        a.rejectedVotes += b.rejectedVotes;
        for (uint256 i = 0; i < a.candidateVotes.length; i++) {
            a.candidateVotes[i] += b.candidateVotes[i];
        }
    }

    function emptyFigures(uint256 candidateCount) internal pure returns (Figures memory f) {
        f.candidateVotes = new uint256[](candidateCount);
    }
}

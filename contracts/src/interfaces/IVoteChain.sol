// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { VoteChainTypes as T } from "../VoteChainTypes.sol";

/// @notice Read/write surface of ElectionManager consumed by the other four modules.
interface IElectionManager {
    enum Category {
        None,
        InecAdmin,
        PresidingOfficer,
        PartyAgent,
        WardCollationOfficer,
        LgaCollationOfficer,
        StateReturningOfficer,
        Auditor,
        ResultPublisher
    }

    struct ElectionInfo {
        string name;
        string electionType;
        string stateName;
        uint64 startTime;
        uint64 endTime;
        T.Phase phase;
        uint64 createdAt;
    }

    struct Lga {
        uint256 id;
        string name;
        uint256[] wardIds;
    }

    struct Ward {
        uint256 id;
        uint256 lgaId;
        string name;
        uint256[] pollingUnitIds;
    }

    struct PollingUnit {
        uint256 id;
        uint256 wardId;
        string code;
        string name;
        uint256 registeredVoters;
        bool cancelled;
        string cancellationCid;
    }

    struct Party {
        uint256 id;
        string name;
        string acronym;
        bool hasCandidate;
        uint256 candidateIndex;
    }

    struct Candidate {
        uint256 index;
        uint256 partyId;
        string name;
    }

    struct Stakeholder {
        Category category;
        T.Level level;
        uint256 unitId;
        uint256 partyId;
    }

    // lifecycle
    function phase() external view returns (T.Phase);
    function markDeclared() external;

    // modules
    function resultUpload() external view returns (address);
    function partyAgentVerification() external view returns (address);
    function collationEngine() external view returns (address);
    function auditDeclaration() external view returns (address);
    function isModule(address account) external view returns (bool);

    // geography & candidates
    function lgaCount() external view returns (uint256);
    function wardCount() external view returns (uint256);
    function pollingUnitCount() external view returns (uint256);
    function partyCount() external view returns (uint256);
    function candidateCount() external view returns (uint256);
    function getLga(uint256 lgaId) external view returns (Lga memory);
    function getWard(uint256 wardId) external view returns (Ward memory);
    function getPollingUnit(uint256 puId) external view returns (PollingUnit memory);
    function getParty(uint256 partyId) external view returns (Party memory);
    function getCandidate(uint256 index) external view returns (Candidate memory);
    function wardIdsOf(uint256 lgaId) external view returns (uint256[] memory);
    function pollingUnitIdsOf(uint256 wardId) external view returns (uint256[] memory);
    function isPollingUnitCancelled(uint256 puId) external view returns (bool);
    function registeredVotersOf(uint256 puId) external view returns (uint256);
    function unitExists(T.Level level, uint256 unitId) external view returns (bool);

    // stakeholders
    function stateReturningOfficer() external view returns (address);
    function auditor() external view returns (address);
    function resultPublisher() external view returns (address);
    function presidingOfficerOf(uint256 puId) external view returns (address);
    function wardOfficerOf(uint256 wardId) external view returns (address);
    function lgaOfficerOf(uint256 lgaId) external view returns (address);
    function isOfficerFor(T.Level level, uint256 unitId, address account) external view returns (bool);
    function isAgentFor(T.Level level, uint256 unitId, address account)
        external
        view
        returns (bool ok, uint256 partyId);
    function agentCount(T.Level level, uint256 unitId) external view returns (uint256);
    function agentsOf(T.Level level, uint256 unitId) external view returns (address[] memory);
    function stakeholderOf(address account) external view returns (Stakeholder memory);
}

/// @notice Multi-party signing, dispute state machine and result status registry.
interface IPartyAgentVerification {
    struct ResultRecord {
        T.ResultStatus status;
        uint32 round;
        uint32 signatureCount;
        bytes32 figuresHash;
        uint256 activeDisputeId;
        uint64 openedAt;
        uint64 approvedAt;
    }

    function statusOf(T.Level level, uint256 unitId) external view returns (T.ResultStatus);
    function isApproved(T.Level level, uint256 unitId) external view returns (bool);
    function currentFiguresHash(T.Level level, uint256 unitId) external view returns (bytes32);
    function getRecord(T.Level level, uint256 unitId) external view returns (ResultRecord memory);
    function pendingEscalations() external view returns (uint256);
    function escalatedDisputeIds() external view returns (uint256[] memory);

    // module-only hooks
    function openSignatureRound(T.Level level, uint256 unitId, bytes32 figuresHash) external;
    function correctFigures(T.Level level, uint256 unitId, bytes32 newFiguresHash, address officer) external;
    function markDeclared(T.Level level, uint256 unitId) external;
}

/// @notice Polling-unit (EC8A) result storage.
interface IResultUpload {
    function getFigures(uint256 puId) external view returns (T.Figures memory);
    function figuresHashOf(uint256 puId) external view returns (bytes32);
}

/// @notice Ward/LGA/State aggregation (EC8B/EC8C/EC8D).
interface ICollationEngine {
    function getFigures(T.Level level, uint256 unitId) external view returns (T.Figures memory);
    function figuresHashOf(T.Level level, uint256 unitId) external view returns (bytes32);
}

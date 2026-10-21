// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import { VoteChainTypes as T } from "./VoteChainTypes.sol";
import { IElectionManager, IPartyAgentVerification, ICollationEngine } from "./interfaces/IVoteChain.sol";

/// @title AuditDeclaration
/// @notice Final gatekeeper module (Section 3.5.5). Once the state-level collation has been approved
///         by the state party agents, the independent state auditor reviews the complete chain
///         (every polling unit -> ward -> LGA -> state, plus every escalated dispute) and submits an
///         ECDSA signature over the state result hash. `verifyAndSign` recovers the signer with
///         `ecrecover` (OpenZeppelin ECDSA) and only sets `auditApproved` when the signer is the
///         registered auditor. `declareResult` is guarded by `require(auditApproved)`, so the result
///         publisher cannot declare before independent verification.
contract AuditDeclaration {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    struct AuditRecord {
        bool approved;
        address auditor;
        bytes32 stateResultHash;
        bytes signature;
        string reportCid; // audit report on IPFS, hash on-chain via the CID
        uint64 approvedAt;
        uint256 blockNumber;
    }

    struct Declaration {
        bool declared;
        address publisher;
        uint64 declaredAt;
        uint256 blockNumber;
        bytes32 stateResultHash;
        uint256 winnerCandidateIndex;
        uint256 winnerPartyId;
        uint256 winnerVotes;
        bool tie;
        T.Figures figures;
    }

    IElectionManager public immutable election;
    IPartyAgentVerification public immutable verification;
    ICollationEngine public immutable collation;

    AuditRecord internal _audit;
    Declaration internal _declaration;

    event AuditApproved(address indexed auditor, bytes32 stateResultHash, string reportCid, uint64 timestamp);
    event ResultDeclared(
        address indexed publisher,
        bytes32 stateResultHash,
        uint256 winnerCandidateIndex,
        uint256 winnerPartyId,
        uint256 winnerVotes,
        bool tie,
        uint64 timestamp
    );

    error StateResultNotApproved(T.ResultStatus status);
    error PendingEscalations(uint256 count);
    error AlreadyAudited();
    error NotAuditorSignature(address recovered, address expected);
    error AuditNotApproved();
    error AlreadyDeclared();
    error NotResultPublisher(address account);
    error StateResultChanged(bytes32 audited, bytes32 current);

    constructor(address electionManager, address partyAgentVerification, address collationEngine) {
        election = IElectionManager(electionManager);
        verification = IPartyAgentVerification(partyAgentVerification);
        collation = ICollationEngine(collationEngine);
    }

    // ---------------------------------------------------------------------
    // Audit
    // ---------------------------------------------------------------------
    /// @notice Hash of the approved state-level figures (bound to the EC8D form CID).
    function stateResultHash() public view returns (bytes32) {
        return verification.currentFiguresHash(T.Level.State, T.STATE_UNIT_ID);
    }

    /// @notice The exact digest the auditor signs (domain-separated by chain and contract address).
    ///         The portal signs it with `personal_sign`, i.e. the EIP-191 prefixed form is verified.
    function auditDigest() public view returns (bytes32) {
        return
            keccak256(abi.encode("VoteChain.AuditApproval", block.chainid, address(this), stateResultHash()));
    }

    /// @notice True when the auditor may sign: state collation approved and no escalation awaiting a ruling.
    function isReadyForAudit() public view returns (bool ready, string memory reason) {
        T.ResultStatus s = verification.statusOf(T.Level.State, T.STATE_UNIT_ID);
        if (s != T.ResultStatus.Approved) {
            return (false, "state collation not approved by state party agents");
        }
        if (verification.pendingEscalations() != 0) {
            return (false, "escalated disputes awaiting auditor ruling");
        }
        if (_audit.approved) return (false, "audit already recorded");
        return (true, "");
    }

    /// @notice Records the independent auditor's verification signature over the state result hash.
    /// @param signature ECDSA signature (EIP-191 personal_sign) of `auditDigest()` by the registered auditor.
    /// @param reportCid IPFS CID of the auditor's full-chain verification report.
    function verifyAndSign(bytes calldata signature, string calldata reportCid) external {
        T.ResultStatus s = verification.statusOf(T.Level.State, T.STATE_UNIT_ID);
        if (s != T.ResultStatus.Approved) revert StateResultNotApproved(s);
        uint256 pending = verification.pendingEscalations();
        if (pending != 0) revert PendingEscalations(pending);
        if (_audit.approved) revert AlreadyAudited();

        bytes32 digest = auditDigest();
        address recovered = digest.toEthSignedMessageHash().recover(signature);
        address expected = election.auditor();
        if (recovered != expected) revert NotAuditorSignature(recovered, expected);

        _audit = AuditRecord({
            approved: true,
            auditor: recovered,
            stateResultHash: stateResultHash(),
            signature: signature,
            reportCid: reportCid,
            approvedAt: uint64(block.timestamp),
            blockNumber: block.number
        });
        emit AuditApproved(recovered, _audit.stateResultHash, reportCid, uint64(block.timestamp));
    }

    // ---------------------------------------------------------------------
    // Declaration
    // ---------------------------------------------------------------------
    /// @notice Final declaration by the state result publisher. Reverts unless `auditApproved`.
    function declareResult() external {
        if (msg.sender != election.resultPublisher()) revert NotResultPublisher(msg.sender);
        if (!_audit.approved) revert AuditNotApproved();
        if (_declaration.declared) revert AlreadyDeclared();
        bytes32 current = stateResultHash();
        if (current != _audit.stateResultHash) revert StateResultChanged(_audit.stateResultHash, current);

        T.Figures memory f = collation.getFigures(T.Level.State, T.STATE_UNIT_ID);
        (uint256 winnerIndex, uint256 winnerVotes, bool tie) = _winner(f);
        uint256 winnerParty = tie ? 0 : election.getCandidate(winnerIndex).partyId;

        _declaration.declared = true;
        _declaration.publisher = msg.sender;
        _declaration.declaredAt = uint64(block.timestamp);
        _declaration.blockNumber = block.number;
        _declaration.stateResultHash = current;
        _declaration.winnerCandidateIndex = winnerIndex;
        _declaration.winnerPartyId = winnerParty;
        _declaration.winnerVotes = winnerVotes;
        _declaration.tie = tie;
        _declaration.figures = f;

        verification.markDeclared(T.Level.State, T.STATE_UNIT_ID);
        election.markDeclared();
        emit ResultDeclared(
            msg.sender, current, winnerIndex, winnerParty, winnerVotes, tie, uint64(block.timestamp)
        );
    }

    function _winner(T.Figures memory f) internal pure returns (uint256 index, uint256 votes, bool tie) {
        for (uint256 i = 0; i < f.candidateVotes.length; i++) {
            if (f.candidateVotes[i] > votes) {
                votes = f.candidateVotes[i];
                index = i;
                tie = false;
            } else if (f.candidateVotes[i] == votes && votes != 0) {
                tie = true;
            }
        }
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------
    function auditApproved() external view returns (bool) {
        return _audit.approved;
    }

    function getAudit() external view returns (AuditRecord memory) {
        return _audit;
    }

    function isDeclared() external view returns (bool) {
        return _declaration.declared;
    }

    function getDeclaration() external view returns (Declaration memory) {
        return _declaration;
    }

    /// @notice Escalated disputes the auditor must rule on before signing.
    function escalatedDisputes() external view returns (uint256[] memory) {
        return verification.escalatedDisputeIds();
    }
}

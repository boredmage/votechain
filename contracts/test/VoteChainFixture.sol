// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import { VoteChainTypes as T } from "../src/VoteChainTypes.sol";
import { ElectionManager } from "../src/ElectionManager.sol";
import { ResultUpload } from "../src/ResultUpload.sol";
import { PartyAgentVerification } from "../src/PartyAgentVerification.sol";
import { CollationEngine } from "../src/CollationEngine.sol";
import { AuditDeclaration } from "../src/AuditDeclaration.sol";
import { IElectionManager } from "../src/interfaces/IVoteChain.sol";

/// @notice Shared fixture: deploys the five modules and builds a configurable Oyo-style geography.
///         Default: 2 LGAs x 2 wards x 2 polling units, 3 parties, one agent per party at every unit.
abstract contract VoteChainFixture is Test {
    ElectionManager internal election;
    ResultUpload internal upload;
    PartyAgentVerification internal verification;
    CollationEngine internal collation;
    AuditDeclaration internal audit;

    address internal admin = makeAddr("inec-admin");
    address internal sro = makeAddr("state-returning-officer");
    address internal publisher = makeAddr("result-publisher");
    address internal auditor;
    uint256 internal auditorPk;
    address internal stranger = makeAddr("stranger");

    uint256 internal constant PARTIES = 3;

    // geography bookkeeping
    uint256 internal lgaCount;
    uint256 internal wardCount;
    uint256 internal puCount;

    mapping(uint256 => address) internal poOf; // puId => presiding officer
    mapping(uint256 => address) internal wardCoOf; // wardId => ward collation officer
    mapping(uint256 => address) internal lgaCoOf; // lgaId => LGA collation officer
    // agent lookup: level => unitId => partyId => agent
    mapping(uint8 => mapping(uint256 => mapping(uint256 => address))) internal agentOf;

    function setUp() public virtual {
        (auditor, auditorPk) = makeAddrAndKey("independent-auditor");
        _deploy();
        _buildGeography(2, 2, 2);
        _registerPartiesAndCandidates();
        _registerOfficers();
        _registerAgents();
    }

    // ------------------------------------------------------------------
    // Deployment
    // ------------------------------------------------------------------
    function _deploy() internal {
        election = new ElectionManager(admin);
        verification = new PartyAgentVerification(address(election));
        upload = new ResultUpload(address(election), address(verification));
        collation = new CollationEngine(address(election), address(verification), address(upload));
        audit = new AuditDeclaration(address(election), address(verification), address(collation));
        vm.startPrank(admin);
        election.setModules(address(upload), address(verification), address(collation), address(audit));
        election.setElectionInfo(
            "2027 Oyo State Governorship Election", "Governorship", "Oyo", uint64(block.timestamp), 0
        );
        vm.stopPrank();
    }

    function _buildGeography(uint256 lgas, uint256 wardsPerLga, uint256 pusPerWard) internal {
        vm.startPrank(admin);
        for (uint256 l = 1; l <= lgas; l++) {
            uint256 lgaId = election.addLga(string.concat("LGA-", vm.toString(l)));
            lgaCount = lgaId;
            for (uint256 w = 1; w <= wardsPerLga; w++) {
                uint256 wardId =
                    election.addWard(lgaId, string.concat("Ward-", vm.toString(l), "-", vm.toString(w)));
                wardCount = wardId;
                for (uint256 p = 1; p <= pusPerWard; p++) {
                    uint256 puId = election.addPollingUnit(
                        wardId,
                        string.concat("OY/", vm.toString(l), "/", vm.toString(w), "/", vm.toString(p)),
                        string.concat("PU-", vm.toString(l), "-", vm.toString(w), "-", vm.toString(p)),
                        1000
                    );
                    puCount = puId;
                }
            }
        }
        vm.stopPrank();
    }

    function _registerPartiesAndCandidates() internal {
        vm.startPrank(admin);
        uint256 a = election.addParty("Progressive Alliance", "PA");
        uint256 b = election.addParty("Democratic Congress", "DC");
        uint256 c = election.addParty("Labour Front", "LF");
        election.addCandidate(a, "Candidate A");
        election.addCandidate(b, "Candidate B");
        election.addCandidate(c, "Candidate C");
        vm.stopPrank();
    }

    function _registerOfficers() internal {
        vm.startPrank(admin);
        for (uint256 pu = 1; pu <= puCount; pu++) {
            address po = makeAddr(string.concat("po-", vm.toString(pu)));
            poOf[pu] = po;
            election.registerPresidingOfficer(po, pu);
        }
        for (uint256 w = 1; w <= wardCount; w++) {
            address co = makeAddr(string.concat("ward-co-", vm.toString(w)));
            wardCoOf[w] = co;
            election.registerWardCollationOfficer(co, w);
        }
        for (uint256 l = 1; l <= lgaCount; l++) {
            address co = makeAddr(string.concat("lga-co-", vm.toString(l)));
            lgaCoOf[l] = co;
            election.registerLgaCollationOfficer(co, l);
        }
        election.registerStateReturningOfficer(sro);
        election.registerAuditor(auditor);
        election.registerResultPublisher(publisher);
        vm.stopPrank();
    }

    function _registerAgents() internal {
        vm.startPrank(admin);
        for (uint256 party = 1; party <= PARTIES; party++) {
            for (uint256 pu = 1; pu <= puCount; pu++) {
                _agent(T.Level.PollingUnit, pu, party);
            }
            for (uint256 w = 1; w <= wardCount; w++) {
                _agent(T.Level.Ward, w, party);
            }
            for (uint256 l = 1; l <= lgaCount; l++) {
                _agent(T.Level.LGA, l, party);
            }
            _agent(T.Level.State, T.STATE_UNIT_ID, party);
        }
        vm.stopPrank();
    }

    function _agent(T.Level level, uint256 unitId, uint256 party) internal returns (address a) {
        a = makeAddr(
            string.concat(
                "agent-L", vm.toString(uint8(level)), "-U", vm.toString(unitId), "-P", vm.toString(party)
            )
        );
        agentOf[uint8(level)][unitId][party] = a;
        election.registerPartyAgent(a, party, level, unitId);
    }

    function activate() internal {
        vm.prank(admin);
        election.activateElection();
    }

    // ------------------------------------------------------------------
    // Figure helpers
    // ------------------------------------------------------------------
    function fig(uint256 reg, uint256 acc, uint256 cast, uint256 valid, uint256 rej, uint256[] memory cv)
        internal
        pure
        returns (T.Figures memory f)
    {
        f.registeredVoters = reg;
        f.accreditedVoters = acc;
        f.totalVotesCast = cast;
        f.validVotes = valid;
        f.rejectedVotes = rej;
        f.candidateVotes = cv;
    }

    function cv3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory v) {
        v = new uint256[](3);
        v[0] = a;
        v[1] = b;
        v[2] = c;
    }

    /// @dev A consistent default PU result: 1000 registered, 600 accredited, 580 cast, 570 valid, 10 rejected.
    function goodFigures() internal pure returns (T.Figures memory) {
        return fig(1000, 600, 580, 570, 10, cv3(300, 200, 70));
    }

    /// @dev Deterministic but varied per-PU figures so aggregates are non-trivial.
    function figuresFor(uint256 puId) internal pure returns (T.Figures memory) {
        uint256 a = 250 + (puId * 7) % 60;
        uint256 b = 180 + (puId * 11) % 50;
        uint256 c = 60 + (puId * 13) % 40;
        uint256 valid = a + b + c;
        uint256 rej = 5 + puId % 4;
        uint256 cast = valid + rej;
        uint256 acc = cast + 20 + puId % 9;
        return fig(1000, acc, cast, valid, rej, cv3(a, b, c));
    }

    function sum(T.Figures memory x, T.Figures memory y) internal pure returns (T.Figures memory) {
        T.Figures memory r = fig(
            x.registeredVoters + y.registeredVoters,
            x.accreditedVoters + y.accreditedVoters,
            x.totalVotesCast + y.totalVotesCast,
            x.validVotes + y.validVotes,
            x.rejectedVotes + y.rejectedVotes,
            new uint256[](x.candidateVotes.length)
        );
        for (uint256 i = 0; i < r.candidateVotes.length; i++) {
            r.candidateVotes[i] = x.candidateVotes[i] + y.candidateVotes[i];
        }
        return r;
    }

    // ------------------------------------------------------------------
    // Flow helpers
    // ------------------------------------------------------------------
    function submitPu(uint256 puId, T.Figures memory f) internal {
        vm.prank(poOf[puId]);
        upload.submitResult(puId, f, string.concat("bafy-ec8a-", vm.toString(puId)));
    }

    function submitPu(uint256 puId) internal {
        submitPu(puId, figuresFor(puId));
    }

    function signAll(T.Level level, uint256 unitId) internal {
        bytes32 h = verification.currentFiguresHash(level, unitId);
        for (uint256 party = 1; party <= PARTIES; party++) {
            vm.prank(agentOf[uint8(level)][unitId][party]);
            verification.signResult(level, unitId, h);
        }
    }

    function approvePu(uint256 puId) internal {
        submitPu(puId);
        signAll(T.Level.PollingUnit, puId);
    }

    function officerFor(T.Level level, uint256 unitId) internal view returns (address) {
        if (level == T.Level.PollingUnit) return poOf[unitId];
        if (level == T.Level.Ward) return wardCoOf[unitId];
        if (level == T.Level.LGA) return lgaCoOf[unitId];
        return sro;
    }

    /// @dev Officer confirms the exact computed aggregate (honest collation) and all agents sign.
    function collate(T.Level level, uint256 unitId) internal {
        (T.Figures memory agg, bool complete,) = collation.computeAggregate(level, unitId);
        require(complete, "fixture: lower level incomplete");
        vm.prank(officerFor(level, unitId));
        bool ok =
            collation.confirmCollation(level, unitId, agg, string.concat("bafy-form-", vm.toString(unitId)));
        require(ok, "fixture: unexpected mismatch");
        signAll(level, unitId);
    }

    /// @dev Runs the entire honest flow up to an approved state collation.
    function runToStateApproved() internal {
        for (uint256 pu = 1; pu <= puCount; pu++) {
            approvePu(pu);
        }
        for (uint256 w = 1; w <= wardCount; w++) {
            collate(T.Level.Ward, w);
        }
        for (uint256 l = 1; l <= lgaCount; l++) {
            collate(T.Level.LGA, l);
        }
        collate(T.Level.State, T.STATE_UNIT_ID);
    }

    function auditorSignature() internal view returns (bytes memory) {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(audit.auditDigest());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(auditorPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function runToDeclared() internal {
        runToStateApproved();
        audit.verifyAndSign(auditorSignature(), "bafy-audit-report");
        vm.prank(publisher);
        audit.declareResult();
    }

    function status(T.Level level, uint256 unitId) internal view returns (T.ResultStatus) {
        return verification.statusOf(level, unitId);
    }

    function assertStatus(T.Level level, uint256 unitId, T.ResultStatus expected) internal view {
        assertEq(uint8(status(level, unitId)), uint8(expected), "unexpected result status");
    }
}

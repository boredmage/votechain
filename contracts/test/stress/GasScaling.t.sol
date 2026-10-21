// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { console2 } from "forge-std/console2.sol";
import { VoteChainFixture } from "../VoteChainFixture.sol";
import { VoteChainTypes as T } from "../../src/VoteChainTypes.sol";
import { ElectionManager } from "../../src/ElectionManager.sol";
import { ResultUpload } from "../../src/ResultUpload.sol";
import { PartyAgentVerification } from "../../src/PartyAgentVerification.sol";
import { CollationEngine } from "../../src/CollationEngine.sol";
import { AuditDeclaration } from "../../src/AuditDeclaration.sol";

/// @notice Gas-scaling stress tests: how the per-transaction cost of the hot paths grows with the
///         number of candidates (C) and the number of children aggregated in one collation (N), and
///         where a single transaction would exceed a 30M block gas limit.
///
///         Measurement: every measured call is preceded by `vm.cool` on all five modules so storage
///         and account accesses are cold, as in a real transaction. Reported numbers are execution
///         gas + 21,000 intrinsic + 16 gas per calldata byte (upper bound), i.e. what the tx needs.
///
///         Run:  forge test --match-contract GasScalingTest -vv
contract GasScalingTest is VoteChainFixture {
    uint256 internal constant BLOCK_LIMIT = 30_000_000;
    uint256 internal C; // candidates in the current build

    function setUp() public override {
        (auditor, auditorPk) = makeAddrAndKey("independent-auditor");
    }

    // ------------------------------------------------------------------
    // builder: fresh deployment, C parties/candidates, geography given as wards-per-LGA x PUs-per-ward,
    // one party agent per unit (agent count does not influence collation cost).
    // ------------------------------------------------------------------
    function _build(uint256 candidates, uint256 lgas, uint256 wardsPerLga, uint256 pusPerWard) internal {
        C = candidates;
        _deploy();
        vm.startPrank(admin);
        for (uint256 i = 1; i <= candidates; i++) {
            uint256 pid = election.addParty("P", "P");
            election.addCandidate(pid, "C");
        }
        for (uint256 l = 1; l <= lgas; l++) {
            uint256 lgaId = election.addLga("L");
            election.registerLgaCollationOfficer(vm.addr(3_000_000 + l), lgaId);
            election.registerPartyAgent(vm.addr(40_000_000 + l), 1, T.Level.LGA, lgaId);
            for (uint256 w = 1; w <= wardsPerLga; w++) {
                uint256 wardId = election.addWard(lgaId, "W");
                election.registerWardCollationOfficer(vm.addr(2_000_000 + wardId), wardId);
                election.registerPartyAgent(vm.addr(30_000_000 + wardId), 1, T.Level.Ward, wardId);
                for (uint256 p = 1; p <= pusPerWard; p++) {
                    uint256 puId = election.addPollingUnit(wardId, "OY", "PU", 100_000);
                    election.registerPresidingOfficer(vm.addr(1_000_000 + puId), puId);
                    election.registerPartyAgent(vm.addr(20_000_000 + puId), 1, T.Level.PollingUnit, puId);
                }
            }
        }
        election.registerStateReturningOfficer(sro);
        election.registerAuditor(auditor);
        election.registerResultPublisher(publisher);
        election.registerPartyAgent(vm.addr(50_000_000), 1, T.Level.State, 1);
        election.activateElection();
        vm.stopPrank();
        lgaCount = election.lgaCount();
        wardCount = election.wardCount();
        puCount = election.pollingUnitCount();
    }

    function _figs(uint256 puId) internal view returns (T.Figures memory f) {
        f.candidateVotes = new uint256[](C);
        uint256 valid;
        for (uint256 i = 0; i < C; i++) {
            f.candidateVotes[i] = 1 + (puId * (i + 3)) % 20;
            valid += f.candidateVotes[i];
        }
        f.validVotes = valid;
        f.rejectedVotes = 3;
        f.totalVotesCast = valid + 3;
        f.accreditedVoters = valid + 10;
        f.registeredVoters = 100_000;
    }

    function _cool() internal {
        vm.cool(address(election));
        vm.cool(address(upload));
        vm.cool(address(verification));
        vm.cool(address(collation));
        vm.cool(address(audit));
    }

    function _txCost(uint256 exec, bytes memory callData) internal pure returns (uint256) {
        return exec + 21_000 + 16 * callData.length;
    }

    function _approvePu(uint256 puId) internal {
        vm.prank(vm.addr(1_000_000 + puId));
        upload.submitResult(puId, _figs(puId), "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi");
        bytes32 h = verification.currentFiguresHash(T.Level.PollingUnit, puId);
        vm.prank(vm.addr(20_000_000 + puId));
        verification.signResult(T.Level.PollingUnit, puId, h);
    }

    function _agentAddr(T.Level level, uint256 unitId) internal pure returns (address) {
        if (level == T.Level.Ward) return vm.addr(30_000_000 + unitId);
        if (level == T.Level.LGA) return vm.addr(40_000_000 + unitId);
        return vm.addr(50_000_000);
    }

    function _officerAddr(T.Level level, uint256 unitId) internal view returns (address) {
        if (level == T.Level.Ward) return vm.addr(2_000_000 + unitId);
        if (level == T.Level.LGA) return vm.addr(3_000_000 + unitId);
        return sro;
    }

    /// @dev Measures one confirmCollation (cold) and then signs it so the level above can proceed.
    function _collateMeasured(T.Level level, uint256 unitId) internal returns (uint256 cost) {
        (T.Figures memory agg, bool complete,) = collation.computeAggregate(level, unitId);
        require(complete, "incomplete");
        bytes memory cd = abi.encodeCall(collation.confirmCollation, (level, unitId, agg, "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"));
        _cool();
        vm.prank(_officerAddr(level, unitId));
        uint256 g = gasleft();
        bool ok = collation.confirmCollation(
            level, unitId, agg, "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
        );
        cost = _txCost(g - gasleft(), cd);
        require(ok, "mismatch");
        bytes32 h = verification.currentFiguresHash(level, unitId);
        vm.prank(_agentAddr(level, unitId));
        verification.signResult(level, unitId, h);
    }

    // ------------------------------------------------------------------
    // 1. EC8A upload and agent signature vs candidate count
    // ------------------------------------------------------------------
    function test_gas_submitResult_vsCandidates() public {
        uint256[8] memory cs = [uint256(2), 3, 5, 10, 18, 30, 50, 100];
        console2.log("C | submitResult tx gas | signResult tx gas");
        for (uint256 i = 0; i < cs.length; i++) {
            _build(cs[i], 1, 1, 1);
            T.Figures memory f = _figs(1);
            bytes memory cd = abi.encodeCall(upload.submitResult, (1, f, "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"));
            _cool();
            vm.prank(vm.addr(1_000_001));
            uint256 g = gasleft();
            upload.submitResult(1, f, "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi");
            uint256 submitCost = _txCost(g - gasleft(), cd);
            bytes32 h = verification.currentFiguresHash(T.Level.PollingUnit, 1);
            cd = abi.encodeCall(verification.signResult, (T.Level.PollingUnit, 1, h));
            _cool();
            vm.prank(vm.addr(20_000_001));
            g = gasleft();
            verification.signResult(T.Level.PollingUnit, 1, h);
            uint256 signCost = _txCost(g - gasleft(), cd);
            console2.log(cs[i], submitCost, signCost);
            assertLt(submitCost, BLOCK_LIMIT);
        }
    }

    // ------------------------------------------------------------------
    // 2. Ward collation vs PUs per ward (N) and candidates (C)
    // ------------------------------------------------------------------
    function test_gas_wardCollation_vsPUsAndCandidates() public {
        uint256[3] memory cs = [uint256(3), 18, 50];
        uint256[4] memory ns = [uint256(5), 13, 40, 100];
        console2.log("C | N PUs | ward confirmCollation tx gas | per-PU marginal | N at 30M (extrapolated)");
        for (uint256 ci = 0; ci < cs.length; ci++) {
            uint256 prevN;
            uint256 prevCost;
            for (uint256 ni = 0; ni < ns.length; ni++) {
                _build(cs[ci], 1, 1, ns[ni]);
                for (uint256 pu = 1; pu <= ns[ni]; pu++) {
                    _approvePu(pu);
                }
                uint256 cost = _collateMeasured(T.Level.Ward, 1);
                uint256 marginal = prevN == 0 ? 0 : (cost - prevCost) / (ns[ni] - prevN);
                uint256 nMax = marginal == 0 ? 0 : ns[ni] + (BLOCK_LIMIT - cost) / marginal;
                console2.log(string.concat(
                    vm.toString(cs[ci]), " | ", vm.toString(ns[ni]), " | ", vm.toString(cost), " | ",
                    vm.toString(marginal), " | ", vm.toString(nMax)
                ));
                prevN = ns[ni];
                prevCost = cost;
            }
        }
    }

    /// @dev Confirms the extrapolation: with 50 candidates a ward of 400 PUs no longer fits in one block,
    ///      and the collation officer has no way to split the aggregation over several transactions.
    function test_gas_wardCollationExceedsBlockLimit_C50_N400() public {
        _build(50, 1, 1, 400);
        for (uint256 pu = 1; pu <= 400; pu++) {
            _approvePu(pu);
        }
        uint256 cost = _collateMeasured(T.Level.Ward, 1);
        console2.log("C=50, N=400 ward confirmCollation tx gas:", cost);
        assertGt(cost, BLOCK_LIMIT, "expected to exceed a 30M block");
    }

    // ------------------------------------------------------------------
    // 3. LGA collation vs wards per LGA, and the state collation over 33 LGAs
    // ------------------------------------------------------------------
    function test_gas_lgaAndStateCollation_Oyo33Lgas() public {
        uint256[3] memory cs = [uint256(3), 18, 50];
        console2.log("C | LGA confirm (11 wards) | LGA confirm (20 wards) | STATE confirm (33 LGAs) | verifyAndSign | declareResult");
        for (uint256 ci = 0; ci < cs.length; ci++) {
            // 33 LGAs; LGA 1 has 20 wards, the rest 1 ward; every ward has 1 PU (PU count is irrelevant here)
            C = cs[ci];
            _deploy();
            vm.startPrank(admin);
            for (uint256 i = 1; i <= C; i++) {
                election.addCandidate(election.addParty("P", "P"), "C");
            }
            for (uint256 l = 1; l <= 33; l++) {
                uint256 lgaId = election.addLga("L");
                election.registerLgaCollationOfficer(vm.addr(3_000_000 + l), lgaId);
                election.registerPartyAgent(vm.addr(40_000_000 + l), 1, T.Level.LGA, lgaId);
                uint256 wards = l == 1 ? 20 : (l == 2 ? 11 : 1);
                for (uint256 w = 1; w <= wards; w++) {
                    uint256 wardId = election.addWard(lgaId, "W");
                    election.registerWardCollationOfficer(vm.addr(2_000_000 + wardId), wardId);
                    election.registerPartyAgent(vm.addr(30_000_000 + wardId), 1, T.Level.Ward, wardId);
                    uint256 puId = election.addPollingUnit(wardId, "OY", "PU", 100_000);
                    election.registerPresidingOfficer(vm.addr(1_000_000 + puId), puId);
                    election.registerPartyAgent(vm.addr(20_000_000 + puId), 1, T.Level.PollingUnit, puId);
                }
            }
            election.registerStateReturningOfficer(sro);
            election.registerAuditor(auditor);
            election.registerResultPublisher(publisher);
            election.registerPartyAgent(vm.addr(50_000_000), 1, T.Level.State, 1);
            election.activateElection();
            vm.stopPrank();

            for (uint256 pu = 1; pu <= election.pollingUnitCount(); pu++) {
                _approvePu(pu);
            }
            for (uint256 w = 1; w <= election.wardCount(); w++) {
                _collateMeasured(T.Level.Ward, w);
            }
            uint256 lga20 = _collateMeasured(T.Level.LGA, 1);
            uint256 lga11 = _collateMeasured(T.Level.LGA, 2);
            for (uint256 l = 3; l <= 33; l++) {
                _collateMeasured(T.Level.LGA, l);
            }
            uint256 st = _collateMeasured(T.Level.State, 1);

            bytes memory sig = auditorSignature();
            _cool();
            uint256 g = gasleft();
            audit.verifyAndSign(sig, "bafy-audit-report");
            uint256 aud = _txCost(g - gasleft(), abi.encodeCall(audit.verifyAndSign, (sig, "bafy-audit-report")));
            _cool();
            vm.prank(publisher);
            g = gasleft();
            audit.declareResult();
            uint256 dec = _txCost(g - gasleft(), abi.encodeCall(audit.declareResult, ()));
            console2.log(string.concat(
                vm.toString(C), " | ", vm.toString(lga11), " | ", vm.toString(lga20), " | ", vm.toString(st),
                " | ", vm.toString(aud), " | ", vm.toString(dec)
            ));
            assertLt(st, BLOCK_LIMIT);
        }
    }

    // ------------------------------------------------------------------
    // 4. Unbounded view used by the auditor portal: escalatedDisputeIds() scans every dispute ever raised
    // ------------------------------------------------------------------
    function test_gas_escalatedDisputeIdsScansAllDisputes() public {
        _build(3, 1, 1, 1);
        vm.prank(vm.addr(1_000_001));
        upload.submitResult(1, _figs(1), "bafy");
        address ag = vm.addr(20_000_001);
        address po = vm.addr(1_000_001);
        for (uint256 i = 0; i < 300; i++) {
            vm.prank(ag);
            uint256 id = verification.raiseDispute(T.Level.PollingUnit, 1, "x", "y");
            vm.prank(po);
            verification.resolveDispute(T.Level.PollingUnit, 1, id, "c", "n");
            vm.prank(ag);
            if (i == 299) verification.escalateDispute(id);
            else verification.acceptResolution(id);
        }
        _cool();
        uint256 g = gasleft();
        uint256[] memory ids = verification.escalatedDisputeIds();
        uint256 used = g - gasleft();
        console2.log("escalatedDisputeIds() over 300 disputes, gas:", used);
        assertEq(ids.length, 1);
        assertEq(ids[0], 300);
        assertGt(used, 300 * 2_000, "linear scan of every dispute");
    }
}

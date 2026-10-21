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

/// @title Scalability benchmarks (Section 3.11.2)
/// @notice Builds an Oyo-style geography of a given size, runs the complete honest collation chain
///         and records the gas cost of every transaction type. Results are written to
///         benchmarks/<scenario>.json for the dissertation's performance evaluation chapter.
///
///   forge test --match-contract BenchmarkTest -vv
///   VOTECHAIN_FULL_SCALE=1 forge test --match-test test_fullOyoState -vv   (33 LGAs / 351 wards / 4,500 PUs)
contract BenchmarkTest is Test {
    struct Stat {
        uint256 count;
        uint256 total;
        uint256 min;
        uint256 max;
    }

    ElectionManager election;
    ResultUpload upload;
    PartyAgentVerification verification;
    CollationEngine collation;
    AuditDeclaration audit;

    address admin = vm.addr(0xA11CE);
    address sro = vm.addr(0x5120);
    address publisher = vm.addr(0x9B15);
    uint256 auditorPk = 0xA0D17;
    address auditor = vm.addr(auditorPk);

    uint256 parties;
    uint256 lgas;
    uint256 wardsPerLga;
    uint256 pusPerWard;
    uint256 puCount;
    uint256 wardCount;

    string[] statNames;
    mapping(string => Stat) stats;
    uint256 deployGas;

    // deterministic account derivation (no labels -> fast at 4,500 PU scale)
    function po(uint256 pu) internal pure returns (address) {
        return vm.addr(1_000_000 + pu);
    }

    function wardCo(uint256 w) internal pure returns (address) {
        return vm.addr(2_000_000 + w);
    }

    function lgaCo(uint256 l) internal pure returns (address) {
        return vm.addr(3_000_000 + l);
    }

    function agent(T.Level level, uint256 unitId, uint256 party) internal pure returns (address) {
        return vm.addr(10_000_000 + uint256(uint8(level)) * 1_000_000 + unitId * 10 + party);
    }

    // ------------------------------------------------------------------
    // Scenarios
    // ------------------------------------------------------------------
    function test_smallScale_singleWard10PUs() public {
        _run("small_single_ward_10_pus", 1, 1, 10, 3);
    }

    function test_mediumScale_singleLga30Wards() public {
        _run("medium_single_lga_30_wards", 1, 30, 10, 3);
    }

    function test_largeScale_multiLga() public {
        _run("large_five_lgas", 5, 10, 12, 3);
    }

    function test_fullOyoState() public {
        if (!vm.envOr("VOTECHAIN_FULL_SCALE", false)) {
            emit log("skipped: set VOTECHAIN_FULL_SCALE=1 to run the 33-LGA / 351-ward / 4,500-PU scenario");
            return;
        }
        // 33 LGAs x 11 wards = 363 wards (Oyo: 351), x 13 PUs = 4,719 PUs (Oyo: ~4,500)
        _run("full_oyo_state", 33, 11, 13, 3);
    }

    // ------------------------------------------------------------------
    // Runner
    // ------------------------------------------------------------------
    function _run(string memory name, uint256 l, uint256 w, uint256 p, uint256 nParties) internal {
        lgas = l;
        wardsPerLga = w;
        pusPerWard = p;
        parties = nParties;
        _deploy();
        _configure();
        _flow();
        _write(name);
    }

    function _deploy() internal {
        uint256 g = gasleft();
        election = new ElectionManager(admin);
        _rec("deploy.ElectionManager", g - gasleft());
        g = gasleft();
        verification = new PartyAgentVerification(address(election));
        _rec("deploy.PartyAgentVerification", g - gasleft());
        g = gasleft();
        upload = new ResultUpload(address(election), address(verification));
        _rec("deploy.ResultUpload", g - gasleft());
        g = gasleft();
        collation = new CollationEngine(address(election), address(verification), address(upload));
        _rec("deploy.CollationEngine", g - gasleft());
        g = gasleft();
        audit = new AuditDeclaration(address(election), address(verification), address(collation));
        _rec("deploy.AuditDeclaration", g - gasleft());
        vm.startPrank(admin);
        election.setModules(address(upload), address(verification), address(collation), address(audit));
        election.setElectionInfo("Benchmark", "Governorship", "Oyo", uint64(block.timestamp), 0);
        vm.stopPrank();
    }

    function _configure() internal {
        vm.startPrank(admin);
        for (uint256 i = 1; i <= parties; i++) {
            uint256 id = election.addParty(
                string.concat("Party ", vm.toString(i)), string.concat("P", vm.toString(i))
            );
            election.addCandidate(id, string.concat("Candidate ", vm.toString(i)));
        }
        for (uint256 li = 1; li <= lgas; li++) {
            uint256 lgaId = election.addLga(string.concat("LGA ", vm.toString(li)));
            for (uint256 wi = 1; wi <= wardsPerLga; wi++) {
                uint256 g = gasleft();
                uint256 wardId = election.addWard(lgaId, string.concat("Ward ", vm.toString(wi)));
                _rec("admin.addWard", g - gasleft());
                for (uint256 pi = 1; pi <= pusPerWard; pi++) {
                    g = gasleft();
                    uint256 puId = election.addPollingUnit(wardId, "OY/00/00/000", "Polling Unit", 1000);
                    _rec("admin.addPollingUnit", g - gasleft());
                    g = gasleft();
                    election.registerPresidingOfficer(po(puId), puId);
                    _rec("admin.registerPresidingOfficer", g - gasleft());
                    for (uint256 pa = 1; pa <= parties; pa++) {
                        g = gasleft();
                        election.registerPartyAgent(
                            agent(T.Level.PollingUnit, puId, pa), pa, T.Level.PollingUnit, puId
                        );
                        _rec("admin.registerPartyAgent", g - gasleft());
                    }
                }
                election.registerWardCollationOfficer(wardCo(wardId), wardId);
                for (uint256 pa = 1; pa <= parties; pa++) {
                    election.registerPartyAgent(agent(T.Level.Ward, wardId, pa), pa, T.Level.Ward, wardId);
                }
            }
            election.registerLgaCollationOfficer(lgaCo(lgaId), lgaId);
            for (uint256 pa = 1; pa <= parties; pa++) {
                election.registerPartyAgent(agent(T.Level.LGA, lgaId, pa), pa, T.Level.LGA, lgaId);
            }
        }
        election.registerStateReturningOfficer(sro);
        election.registerAuditor(auditor);
        election.registerResultPublisher(publisher);
        for (uint256 pa = 1; pa <= parties; pa++) {
            election.registerPartyAgent(
                agent(T.Level.State, T.STATE_UNIT_ID, pa), pa, T.Level.State, T.STATE_UNIT_ID
            );
        }
        election.activateElection();
        vm.stopPrank();
        puCount = election.pollingUnitCount();
        wardCount = election.wardCount();
    }

    function _figures(uint256 puId) internal view returns (T.Figures memory f) {
        f.candidateVotes = new uint256[](parties);
        uint256 valid;
        for (uint256 i = 0; i < parties; i++) {
            f.candidateVotes[i] = 100 + (puId * (i + 7)) % 150;
            valid += f.candidateVotes[i];
        }
        f.validVotes = valid;
        f.rejectedVotes = puId % 6;
        f.totalVotesCast = valid + f.rejectedVotes;
        f.accreditedVoters = f.totalVotesCast + 15;
        f.registeredVoters = 1000;
    }

    function _flow() internal {
        // 1. polling units: submit + n signatures
        for (uint256 pu = 1; pu <= puCount; pu++) {
            T.Figures memory f = _figures(pu);
            vm.prank(po(pu));
            uint256 g = gasleft();
            upload.submitResult(pu, f, "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi");
            _rec("po.submitResult", g - gasleft());
            _signAll(T.Level.PollingUnit, pu, "agent.signResult.pu");
        }
        // 2. wards
        for (uint256 w = 1; w <= wardCount; w++) {
            _collate(T.Level.Ward, w, wardCo(w), "officer.confirmCollation.ward");
            _signAll(T.Level.Ward, w, "agent.signResult.ward");
        }
        // 3. LGAs
        for (uint256 l = 1; l <= lgas; l++) {
            _collate(T.Level.LGA, l, lgaCo(l), "officer.confirmCollation.lga");
            _signAll(T.Level.LGA, l, "agent.signResult.lga");
        }
        // 4. state
        _collate(T.Level.State, T.STATE_UNIT_ID, sro, "officer.confirmCollation.state");
        _signAll(T.Level.State, T.STATE_UNIT_ID, "agent.signResult.state");

        // 5. audit + declaration
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(audit.auditDigest());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(auditorPk, digest);
        uint256 g2 = gasleft();
        audit.verifyAndSign(abi.encodePacked(r, s, v), "bafy-audit-report");
        _rec("auditor.verifyAndSign", g2 - gasleft());
        vm.prank(publisher);
        g2 = gasleft();
        audit.declareResult();
        _rec("publisher.declareResult", g2 - gasleft());
        require(audit.isDeclared(), "not declared");

        // 6. a dispute cycle on a fresh deployment is measured in the unit tests; here we measure the
        //    read-side cost of public verification of one ward, one LGA and the state.
        uint256 g3 = gasleft();
        collation.verifyConsistency(T.Level.Ward, 1);
        _rec("public.verifyConsistency.ward", g3 - gasleft());
        g3 = gasleft();
        collation.verifyConsistency(T.Level.LGA, 1);
        _rec("public.verifyConsistency.lga", g3 - gasleft());
        g3 = gasleft();
        collation.verifyConsistency(T.Level.State, T.STATE_UNIT_ID);
        _rec("public.verifyConsistency.state", g3 - gasleft());
    }

    function _signAll(T.Level level, uint256 unitId, string memory statName) internal {
        bytes32 h = verification.currentFiguresHash(level, unitId);
        for (uint256 pa = 1; pa <= parties; pa++) {
            vm.prank(agent(level, unitId, pa));
            uint256 g = gasleft();
            verification.signResult(level, unitId, h);
            _rec(statName, g - gasleft());
        }
        require(verification.isApproved(level, unitId), "not approved");
    }

    function _collate(T.Level level, uint256 unitId, address officer, string memory statName) internal {
        (T.Figures memory agg, bool complete,) = collation.computeAggregate(level, unitId);
        require(complete, "incomplete");
        vm.prank(officer);
        uint256 g = gasleft();
        bool ok = collation.confirmCollation(
            level, unitId, agg, "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
        );
        _rec(statName, g - gasleft());
        require(ok, "mismatch");
    }

    // ------------------------------------------------------------------
    // Stats & output
    // ------------------------------------------------------------------
    function _rec(string memory name, uint256 gas) internal {
        Stat storage s = stats[name];
        if (s.count == 0) {
            statNames.push(name);
            s.min = gas;
        }
        s.count += 1;
        s.total += gas;
        if (gas < s.min) s.min = gas;
        if (gas > s.max) s.max = gas;
    }

    function _write(string memory scenario) internal {
        uint256 blockGasLimit = 30_000_000; // Sepolia / mainnet default
        uint256 blockTime = 12; // seconds

        uint256 flowGas;
        string memory txJson = "txTypes";
        string memory out;
        for (uint256 i = 0; i < statNames.length; i++) {
            Stat memory s = stats[statNames[i]];
            string memory item = statNames[i];
            vm.serializeUint(item, "count", s.count);
            vm.serializeUint(item, "totalGas", s.total);
            vm.serializeUint(item, "minGas", s.min);
            vm.serializeUint(item, "maxGas", s.max);
            string memory obj = vm.serializeUint(item, "avgGas", s.total / s.count);
            out = vm.serializeString(txJson, item, obj);
            if (
                !_startsWith(item, "deploy.") && !_startsWith(item, "admin.") && !_startsWith(item, "public.")
            ) {
                flowGas += s.total;
            }
        }
        Stat memory submit = stats["po.submitResult"];
        uint256 avgSubmit = submit.total / submit.count;
        uint256 submissionsPerBlock = blockGasLimit / avgSubmit;

        string memory root = "root";
        vm.serializeString(root, "scenario", scenario);
        vm.serializeUint(root, "lgas", lgas);
        vm.serializeUint(root, "wards", wardCount);
        vm.serializeUint(root, "pollingUnits", puCount);
        vm.serializeUint(root, "parties", parties);
        vm.serializeUint(root, "collationFlowGasTotal", flowGas);
        vm.serializeUint(root, "assumedBlockGasLimit", blockGasLimit);
        vm.serializeUint(root, "assumedBlockTimeSeconds", blockTime);
        vm.serializeUint(root, "submissionsPerBlock", submissionsPerBlock);
        vm.serializeUint(root, "submissionsPerMinute", submissionsPerBlock * 60 / blockTime);
        vm.serializeUint(root, "blocksNeededThroughputBound", (flowGas + blockGasLimit - 1) / blockGasLimit);
        vm.serializeUint(
            root, "throughputBoundSeconds", ((flowGas + blockGasLimit - 1) / blockGasLimit) * blockTime
        );
        // critical path: submit, PU sign, ward confirm, ward sign, LGA confirm, LGA sign, state confirm,
        // state sign, audit, declare = 10 dependent blocks
        vm.serializeUint(root, "criticalPathBlocks", 10);
        vm.serializeUint(root, "latencyLowerBoundSeconds", 10 * blockTime);
        string memory json = vm.serializeString(root, "txTypes", out);
        vm.writeJson(json, string.concat("benchmarks/", scenario, ".json"));

        emit log_named_string("scenario", scenario);
        emit log_named_uint("polling units", puCount);
        emit log_named_uint("wards", wardCount);
        emit log_named_uint("collation flow gas (total)", flowGas);
        emit log_named_uint("avg submitResult gas", avgSubmit);
        emit log_named_uint(
            "submissions per minute (30M gas blocks, 12s)", submissionsPerBlock * 60 / blockTime
        );
    }

    function _startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(prefix);
        if (b.length > a.length) return false;
        for (uint256 i = 0; i < b.length; i++) {
            if (a[i] != b[i]) return false;
        }
        return true;
    }
}

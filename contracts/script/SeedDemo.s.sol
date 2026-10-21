// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Script, console } from "forge-std/Script.sol";
import { VoteChainTypes as T } from "../src/VoteChainTypes.sol";
import { ElectionManager } from "../src/ElectionManager.sol";
import { ResultUpload } from "../src/ResultUpload.sol";
import { PartyAgentVerification } from "../src/PartyAgentVerification.sol";
import { CollationEngine } from "../src/CollationEngine.sol";

/// @notice Configures a demonstration election on a local node using the standard test mnemonic, so
///         every stakeholder role has a known account that can be imported into MetaMask.
///
///   forge script script/SeedDemo.s.sol --rpc-url localhost --broadcast
///
/// Demo geography (Oyo State): 2 LGAs x 2 wards x 2 polling units = 8 polling units, 3 parties.
/// Account layout (mnemonic index -> role) is written to deployments/demo-accounts.json.
///
/// Environment:
///   DEPLOYMENT_NAME  deployments/<name>.json to read (default: localhost)
///   DEMO_PREFILL     1 = also submit + sign every polling unit of LGA 2 and collate its wards, leaving
///                    LGA 1 for a live walkthrough (default: 0)
contract SeedDemo is Script {
    string constant MNEMONIC = "test test test test test test test test test test test junk";
    uint256 constant PARTIES = 3;

    ElectionManager election;
    ResultUpload upload;
    PartyAgentVerification verification;
    CollationEngine collation;

    string accountsJson = "accounts";
    string[] entries;

    // index bookkeeping: 0 admin, 1 SRO, 2 auditor, 3 publisher, then 4.. allocated sequentially
    uint256 nextIndex = 4;

    struct Assigned {
        uint256 index;
        address addr;
    }

    mapping(uint256 => uint256) poIndex; // puId => mnemonic index
    mapping(uint256 => uint256) wardCoIndex;
    mapping(uint256 => uint256) lgaCoIndex;
    mapping(uint8 => mapping(uint256 => mapping(uint256 => uint256))) agentIndex; // level => unit => party => index

    function run() external {
        string memory name = vm.envOr("DEPLOYMENT_NAME", string("localhost"));
        string memory json = vm.readFile(string.concat("deployments/", name, ".json"));
        election = ElectionManager(vm.parseJsonAddress(json, ".contracts.ElectionManager"));
        upload = ResultUpload(vm.parseJsonAddress(json, ".contracts.ResultUpload"));
        verification = PartyAgentVerification(vm.parseJsonAddress(json, ".contracts.PartyAgentVerification"));
        collation = CollationEngine(vm.parseJsonAddress(json, ".contracts.CollationEngine"));

        uint256 adminPk = vm.deriveKey(MNEMONIC, 0);
        _record("INEC Admin", "InecAdmin", 0, 0, 0, 0);

        vm.startBroadcast(adminPk);
        election.setElectionInfo(
            "2027 Oyo State Governorship Election (Demo)", "Governorship", "Oyo", uint64(block.timestamp), 0
        );

        // parties & candidates (fictional)
        uint256 pa = election.addParty("Progressive Alliance", "PA");
        uint256 dc = election.addParty("Democratic Congress", "DC");
        uint256 lf = election.addParty("Labour Front", "LF");
        election.addCandidate(pa, "Adebayo Ogunleye");
        election.addCandidate(dc, "Folasade Akintola");
        election.addCandidate(lf, "Chukwuemeka Balogun");

        // geography
        uint256 ibadanNorth = election.addLga("Ibadan North");
        uint256 akinyele = election.addLga("Akinyele");
        uint256 w1 = election.addWard(ibadanNorth, "Ward 01 - Agbowo");
        uint256 w2 = election.addWard(ibadanNorth, "Ward 02 - Bodija");
        uint256 w3 = election.addWard(akinyele, "Ward 01 - Moniya");
        uint256 w4 = election.addWard(akinyele, "Ward 02 - Ojoo");
        election.addPollingUnit(w1, "OY/11/01/001", "Community Primary School I", 812);
        election.addPollingUnit(w1, "OY/11/01/002", "Community Primary School II", 954);
        election.addPollingUnit(w2, "OY/11/02/001", "Bodija Market Square", 1103);
        election.addPollingUnit(w2, "OY/11/02/002", "Bodija Estate Hall", 776);
        election.addPollingUnit(w3, "OY/01/01/001", "Moniya Central Mosque Front", 998);
        election.addPollingUnit(w3, "OY/01/01/002", "Moniya Motor Park", 1240);
        election.addPollingUnit(w4, "OY/01/02/001", "Ojoo Baptist Primary School", 867);
        election.addPollingUnit(w4, "OY/01/02/002", "Ojoo Bus Stop Open Space", 1015);

        // state-level officers
        election.registerStateReturningOfficer(_addr(1));
        _record(
            "State Returning Officer", "StateReturningOfficer", 1, uint8(T.Level.State), T.STATE_UNIT_ID, 0
        );
        election.registerAuditor(_addr(2));
        _record("Independent State Auditor", "Auditor", 2, uint8(T.Level.State), T.STATE_UNIT_ID, 0);
        election.registerResultPublisher(_addr(3));
        _record("State Result Publisher", "ResultPublisher", 3, uint8(T.Level.State), T.STATE_UNIT_ID, 0);

        // presiding officers
        for (uint256 pu = 1; pu <= 8; pu++) {
            uint256 i = nextIndex++;
            poIndex[pu] = i;
            election.registerPresidingOfficer(_addr(i), pu);
            _record(
                string.concat("Presiding Officer - ", election.getPollingUnit(pu).code),
                "PresidingOfficer",
                i,
                uint8(T.Level.PollingUnit),
                pu,
                0
            );
        }
        // ward & LGA collation officers
        for (uint256 w = 1; w <= 4; w++) {
            uint256 i = nextIndex++;
            wardCoIndex[w] = i;
            election.registerWardCollationOfficer(_addr(i), w);
            _record(
                string.concat("Ward Collation Officer - ", election.getWard(w).name),
                "WardCollationOfficer",
                i,
                uint8(T.Level.Ward),
                w,
                0
            );
        }
        for (uint256 l = 1; l <= 2; l++) {
            uint256 i = nextIndex++;
            lgaCoIndex[l] = i;
            election.registerLgaCollationOfficer(_addr(i), l);
            _record(
                string.concat("LGA Collation Officer - ", election.getLga(l).name),
                "LgaCollationOfficer",
                i,
                uint8(T.Level.LGA),
                l,
                0
            );
        }
        // party agents at every level
        for (uint256 party = 1; party <= PARTIES; party++) {
            for (uint256 pu = 1; pu <= 8; pu++) {
                _agent(T.Level.PollingUnit, pu, party, election.getPollingUnit(pu).code);
            }
            for (uint256 w = 1; w <= 4; w++) {
                _agent(T.Level.Ward, w, party, election.getWard(w).name);
            }
            for (uint256 l = 1; l <= 2; l++) {
                _agent(T.Level.LGA, l, party, election.getLga(l).name);
            }
            _agent(T.Level.State, T.STATE_UNIT_ID, party, "Oyo State");
        }

        election.activateElection();
        vm.stopBroadcast();

        if (vm.envOr("DEMO_PREFILL", uint256(0)) == 1) {
            _prefillLga2();
        }

        _writeAccounts();
        console.log(
            "Demo election configured and activated. Accounts written to deployments/demo-accounts.json"
        );
        console.log("Total demo accounts:", nextIndex);
    }

    function _agent(T.Level level, uint256 unitId, uint256 party, string memory unitLabel) internal {
        uint256 i = nextIndex++;
        agentIndex[uint8(level)][unitId][party] = i;
        election.registerPartyAgent(_addr(i), party, level, unitId);
        _record(
            string.concat(election.getParty(party).acronym, " Agent - ", _levelName(level), " ", unitLabel),
            "PartyAgent",
            i,
            uint8(level),
            unitId,
            party
        );
    }

    /// @dev Submits + signs every polling unit in LGA 2 (PUs 5-8) and collates its two wards.
    function _prefillLga2() internal {
        for (uint256 pu = 5; pu <= 8; pu++) {
            T.Figures memory f = _figures(pu);
            vm.startBroadcast(vm.deriveKey(MNEMONIC, uint32(poIndex[pu])));
            upload.submitResult(pu, f, "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi");
            vm.stopBroadcast();
            _signAll(T.Level.PollingUnit, pu);
        }
        for (uint256 w = 3; w <= 4; w++) {
            (T.Figures memory agg, bool complete,) = collation.computeAggregate(T.Level.Ward, w);
            require(complete, "prefill: ward incomplete");
            vm.startBroadcast(vm.deriveKey(MNEMONIC, uint32(wardCoIndex[w])));
            collation.confirmCollation(
                T.Level.Ward, w, agg, "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
            );
            vm.stopBroadcast();
            _signAll(T.Level.Ward, w);
        }
        console.log("Prefilled LGA 2 (polling units 5-8 approved, wards 3-4 approved)");
    }

    function _signAll(T.Level level, uint256 unitId) internal {
        bytes32 h = verification.currentFiguresHash(level, unitId);
        for (uint256 party = 1; party <= PARTIES; party++) {
            vm.startBroadcast(vm.deriveKey(MNEMONIC, uint32(agentIndex[uint8(level)][unitId][party])));
            verification.signResult(level, unitId, h);
            vm.stopBroadcast();
        }
    }

    function _figures(uint256 puId) internal view returns (T.Figures memory f) {
        uint256 registered = election.getPollingUnit(puId).registeredVoters;
        f.candidateVotes = new uint256[](PARTIES);
        f.candidateVotes[0] = 180 + (puId * 37) % 90;
        f.candidateVotes[1] = 150 + (puId * 53) % 80;
        f.candidateVotes[2] = 40 + (puId * 19) % 50;
        f.validVotes = f.candidateVotes[0] + f.candidateVotes[1] + f.candidateVotes[2];
        f.rejectedVotes = 3 + puId % 5;
        f.totalVotesCast = f.validVotes + f.rejectedVotes;
        f.accreditedVoters = f.totalVotesCast + 12 + puId % 7;
        f.registeredVoters = registered;
    }

    // ------------------------------------------------------------------
    // account book-keeping
    // ------------------------------------------------------------------
    function _addr(uint256 index) internal pure returns (address) {
        return vm.addr(vm.deriveKey(MNEMONIC, uint32(index)));
    }

    function _record(
        string memory role,
        string memory category,
        uint256 index,
        uint8 level,
        uint256 unitId,
        uint256 partyId
    ) internal {
        string memory key = string.concat("acct", vm.toString(index));
        vm.serializeString(key, "role", role);
        vm.serializeString(key, "category", category);
        vm.serializeUint(key, "index", index);
        vm.serializeUint(key, "level", level);
        vm.serializeUint(key, "unitId", unitId);
        vm.serializeUint(key, "partyId", partyId);
        vm.serializeAddress(key, "address", _addr(index));
        string memory obj =
            vm.serializeBytes32(key, "privateKey", bytes32(vm.deriveKey(MNEMONIC, uint32(index))));
        entries.push(obj);
    }

    function _writeAccounts() internal {
        // assemble a JSON array manually (forge-std serializes objects, not arrays of objects)
        string memory arr = "[";
        for (uint256 i = 0; i < entries.length; i++) {
            arr = string.concat(arr, i == 0 ? "" : ",", entries[i]);
        }
        arr = string.concat(arr, "]");
        string memory root = "demo";
        vm.serializeString(root, "mnemonic", MNEMONIC);
        vm.serializeString(root, "warning", "Publicly known test keys - never use on a real network");
        vm.serializeUint(root, "chainId", block.chainid);
        string memory json = vm.serializeString(root, "accounts", "[]");
        vm.writeJson(json, "deployments/demo-accounts.json");
        // second pass: replace the placeholder with the real JSON array (strings would otherwise be escaped)
        vm.writeJson(arr, "deployments/demo-accounts.json", ".accounts");
    }

    function _levelName(T.Level level) internal pure returns (string memory) {
        if (level == T.Level.PollingUnit) return "PU";
        if (level == T.Level.Ward) return "Ward";
        if (level == T.Level.LGA) return "LGA";
        return "State";
    }
}

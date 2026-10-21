// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Script, console } from "forge-std/Script.sol";
import { ElectionManager } from "../src/ElectionManager.sol";
import { ResultUpload } from "../src/ResultUpload.sol";
import { PartyAgentVerification } from "../src/PartyAgentVerification.sol";
import { CollationEngine } from "../src/CollationEngine.sol";
import { AuditDeclaration } from "../src/AuditDeclaration.sol";

/// @notice Deploys the five VoteChain modules and wires them together.
///
///   Local (Anvil / Hardhat node on :8545):
///     forge script script/Deploy.s.sol --rpc-url localhost --broadcast
///   Sepolia:
///     PRIVATE_KEY=0x... SEPOLIA_RPC_URL=https://... forge script script/Deploy.s.sol --rpc-url sepolia --broadcast --verify
///
/// Environment:
///   PRIVATE_KEY   deployer key (defaults to Anvil/Hardhat account #0)
///   INEC_ADMIN    address that receives INEC_ADMIN_ROLE (defaults to the deployer)
///   DEPLOYMENT_NAME  file name under deployments/ (defaults to the chain id)
contract Deploy is Script {
    string constant DEFAULT_MNEMONIC = "test test test test test test test test test test test junk";

    function run() external returns (ElectionManager election) {
        uint256 pk = vm.envOr("PRIVATE_KEY", vm.deriveKey(DEFAULT_MNEMONIC, 0));
        address deployer = vm.addr(pk);
        address inecAdmin = vm.envOr("INEC_ADMIN", deployer);

        vm.startBroadcast(pk);
        election = new ElectionManager(inecAdmin);
        PartyAgentVerification verification = new PartyAgentVerification(address(election));
        ResultUpload upload = new ResultUpload(address(election), address(verification));
        CollationEngine collation =
            new CollationEngine(address(election), address(verification), address(upload));
        AuditDeclaration audit =
            new AuditDeclaration(address(election), address(verification), address(collation));
        if (inecAdmin == deployer) {
            election.setModules(address(upload), address(verification), address(collation), address(audit));
        }
        vm.stopBroadcast();

        console.log("ElectionManager        ", address(election));
        console.log("PartyAgentVerification ", address(verification));
        console.log("ResultUpload           ", address(upload));
        console.log("CollationEngine        ", address(collation));
        console.log("AuditDeclaration       ", address(audit));
        if (inecAdmin != deployer) {
            console.log(
                "NOTE: INEC admin differs from deployer - call election.setModules(...) from the admin account."
            );
        }

        _writeDeployment(
            address(election), address(verification), address(upload), address(collation), address(audit)
        );
    }

    function _writeDeployment(address em, address pav, address ru, address ce, address ad) internal {
        string memory name = vm.envOr("DEPLOYMENT_NAME", _defaultName());
        string memory c = "contracts";
        vm.serializeAddress(c, "ElectionManager", em);
        vm.serializeAddress(c, "PartyAgentVerification", pav);
        vm.serializeAddress(c, "ResultUpload", ru);
        vm.serializeAddress(c, "CollationEngine", ce);
        string memory contracts = vm.serializeAddress(c, "AuditDeclaration", ad);

        string memory root = "deployment";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeString(root, "network", name);
        vm.serializeUint(root, "deployBlock", block.number);
        vm.serializeUint(root, "deployedAt", block.timestamp);
        string memory json = vm.serializeString(root, "contracts", contracts);
        string memory path = string.concat("deployments/", name, ".json");
        vm.writeJson(json, path);
        console.log("wrote", path);
    }

    function _defaultName() internal view returns (string memory) {
        if (block.chainid == 31337) return "localhost";
        if (block.chainid == 11155111) return "sepolia";
        return vm.toString(block.chainid);
    }
}

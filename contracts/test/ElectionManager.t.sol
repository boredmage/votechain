// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { VoteChainFixture } from "./VoteChainFixture.sol";
import { VoteChainTypes as T } from "../src/VoteChainTypes.sol";
import { ElectionManager } from "../src/ElectionManager.sol";
import { IElectionManager } from "../src/interfaces/IVoteChain.sol";

contract ElectionManagerTest is VoteChainFixture {
    // ------------------------------------------------------------------
    // Configuration & geography
    // ------------------------------------------------------------------
    function test_geographyIsRegistered() public view {
        assertEq(election.lgaCount(), 2);
        assertEq(election.wardCount(), 4);
        assertEq(election.pollingUnitCount(), 8);
        assertEq(election.partyCount(), 3);
        assertEq(election.candidateCount(), 3);

        IElectionManager.Ward memory w = election.getWard(3);
        assertEq(w.lgaId, 2);
        assertEq(w.pollingUnitIds.length, 2);
        assertEq(w.pollingUnitIds[0], 5);

        IElectionManager.PollingUnit memory pu = election.getPollingUnit(5);
        assertEq(pu.wardId, 3);
        assertEq(pu.registeredVoters, 1000);
        assertEq(pu.code, "OY/2/1/1");
    }

    function test_electionInfoStored() public view {
        IElectionManager.ElectionInfo memory info = election.getElectionInfo();
        assertEq(info.name, "2027 Oyo State Governorship Election");
        assertEq(info.stateName, "Oyo");
        assertEq(uint8(info.phase), uint8(T.Phase.Registration));
    }

    function test_onlyAdminCanConfigure() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bytes32(0)
            )
        );
        election.addLga("Ibadan North");
    }

    function test_candidatePerPartyIsUnique() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ElectionManager.DuplicateCandidate.selector, 1));
        election.addCandidate(1, "Second candidate for party 1");
    }

    function test_unknownParentUnitReverts() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(T.UnknownUnit.selector, T.Level.LGA, 99));
        election.addWard(99, "Nowhere");
        vm.expectRevert(abi.encodeWithSelector(T.UnknownUnit.selector, T.Level.Ward, 99));
        election.addPollingUnit(99, "X", "X", 10);
        vm.stopPrank();
    }

    function test_batchPollingUnits() public {
        string[] memory codes = new string[](3);
        string[] memory names = new string[](3);
        uint256[] memory reg = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) {
            codes[i] = string.concat("OY/9/", vm.toString(i));
            names[i] = string.concat("Batch PU ", vm.toString(i));
            reg[i] = 500 + i;
        }
        vm.prank(admin);
        (uint256 first, uint256 last) = election.addPollingUnits(1, codes, names, reg);
        assertEq(first, 9);
        assertEq(last, 11);
        assertEq(election.getPollingUnit(11).registeredVoters, 502);
        assertEq(election.pollingUnitIdsOf(1).length, 5);
    }

    // ------------------------------------------------------------------
    // Stakeholders
    // ------------------------------------------------------------------
    function test_rolesAndScopesAssigned() public view {
        assertTrue(election.hasRole(election.PRESIDING_OFFICER_ROLE(), poOf[1]));
        assertTrue(election.hasRole(election.PARTY_AGENT_ROLE(), agentOf[0][1][1]));
        assertTrue(election.hasRole(election.WARD_COLLATION_OFFICER_ROLE(), wardCoOf[1]));
        assertTrue(election.hasRole(election.LGA_COLLATION_OFFICER_ROLE(), lgaCoOf[1]));
        assertTrue(election.hasRole(election.STATE_RETURNING_OFFICER_ROLE(), sro));
        assertTrue(election.hasRole(election.AUDITOR_ROLE(), auditor));
        assertTrue(election.hasRole(election.RESULT_PUBLISHER_ROLE(), publisher));

        IElectionManager.Stakeholder memory s = election.stakeholderOf(agentOf[1][2][3]);
        assertEq(uint8(s.category), uint8(IElectionManager.Category.PartyAgent));
        assertEq(uint8(s.level), uint8(T.Level.Ward));
        assertEq(s.unitId, 2);
        assertEq(s.partyId, 3);

        assertEq(election.agentCount(T.Level.PollingUnit, 1), 3);
        assertEq(election.agentCount(T.Level.State, T.STATE_UNIT_ID), 3);
        (bool ok, uint256 party) = election.isAgentFor(T.Level.LGA, 2, agentOf[2][2][2]);
        assertTrue(ok);
        assertEq(party, 2);
        (ok,) = election.isAgentFor(T.Level.LGA, 1, agentOf[2][2][2]);
        assertFalse(ok, "agent must not be valid for another unit");
    }

    function test_separationOfDuties_oneCategoryPerAddress() public {
        vm.startPrank(admin);
        // free the party-1 slot at ward 1, then try to fill it with a presiding officer
        election.revokeStakeholder(agentOf[1][1][1]);
        vm.expectRevert(
            abi.encodeWithSelector(
                ElectionManager.AlreadyAssigned.selector, poOf[1], IElectionManager.Category.PresidingOfficer
            )
        );
        election.registerPartyAgent(poOf[1], 1, T.Level.Ward, 1);
        // auditor cannot also be publisher (free the publisher slot first)
        election.revokeStakeholder(publisher);
        vm.expectRevert(
            abi.encodeWithSelector(
                ElectionManager.AlreadyAssigned.selector, auditor, IElectionManager.Category.Auditor
            )
        );
        election.registerResultPublisher(auditor);
        vm.stopPrank();
    }

    function test_onePartyAgentPerPartyPerUnit() public {
        address extra = makeAddr("extra-agent");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ElectionManager.AlreadyTaken.selector, T.Level.PollingUnit, 1));
        election.registerPartyAgent(extra, 1, T.Level.PollingUnit, 1);
    }

    function test_revokeStakeholderClearsScope() public {
        address agent = agentOf[0][1][2];
        vm.prank(admin);
        election.revokeStakeholder(agent);
        assertFalse(election.hasRole(election.PARTY_AGENT_ROLE(), agent));
        assertEq(election.agentCount(T.Level.PollingUnit, 1), 2);
        assertEq(uint8(election.stakeholderOf(agent).category), uint8(IElectionManager.Category.None));
        // slot is free again
        address replacement = makeAddr("replacement");
        vm.prank(admin);
        election.registerPartyAgent(replacement, 2, T.Level.PollingUnit, 1);
        assertEq(election.agentCount(T.Level.PollingUnit, 1), 3);
    }

    function test_grantRoleBypassIsBlocked() public {
        bytes32 agentRole = election.PARTY_AGENT_ROLE();
        address agent = agentOf[0][1][1];
        vm.startPrank(admin);
        vm.expectRevert(ElectionManager.UseRegistrationFunctions.selector);
        election.grantRole(agentRole, stranger);
        vm.expectRevert(ElectionManager.UseRegistrationFunctions.selector);
        election.revokeRole(agentRole, agent);
        vm.stopPrank();

        vm.prank(agent);
        vm.expectRevert(ElectionManager.RenounceDisabled.selector);
        election.renounceRole(agentRole, agent);
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------
    function test_lifecycleTransitions() public {
        assertEq(uint8(election.phase()), uint8(T.Phase.Registration));
        activate();
        assertEq(uint8(election.phase()), uint8(T.Phase.Active));

        // registration is now frozen
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(T.WrongPhase.selector, T.Phase.Active, T.Phase.Registration));
        election.addLga("Late LGA");
        vm.expectRevert(abi.encodeWithSelector(T.WrongPhase.selector, T.Phase.Active, T.Phase.Registration));
        election.registerPartyAgent(stranger, 1, T.Level.Ward, 1);
        vm.expectRevert(abi.encodeWithSelector(T.WrongPhase.selector, T.Phase.Active, T.Phase.Registration));
        election.revokeStakeholder(poOf[1]);
        election.closeSubmissions();
        vm.stopPrank();
        assertEq(uint8(election.phase()), uint8(T.Phase.Collation));

        // only the audit module can declare
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(T.NotAuthorised.selector, admin));
        election.markDeclared();
    }

    function test_activationRequiresCompleteSetup() public {
        ElectionManager fresh = new ElectionManager(admin);
        vm.startPrank(admin);
        vm.expectRevert(ElectionManager.ModulesNotSet.selector);
        fresh.activateElection();
        fresh.setModules(address(1), address(2), address(3), address(4));
        vm.expectRevert(abi.encodeWithSelector(ElectionManager.NotReadyToActivate.selector, "geography"));
        fresh.activateElection();
        vm.stopPrank();
    }

    function test_cancelPollingUnit() public {
        activate();
        vm.prank(admin);
        election.cancelPollingUnit(2, "bafy-cancellation-2");
        assertTrue(election.isPollingUnitCancelled(2));

        // cannot cancel twice, cannot cancel a unit that already has figures
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(ElectionManager.AlreadyCancelled.selector, 2));
        election.cancelPollingUnit(2, "again");
        vm.stopPrank();
        submitPu(1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ElectionManager.PollingUnitHasResult.selector, 1));
        election.cancelPollingUnit(1, "too late");
    }
}

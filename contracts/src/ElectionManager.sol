// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { VoteChainTypes as T } from "./VoteChainTypes.sol";
import { IElectionManager, IPartyAgentVerification } from "./interfaces/IVoteChain.sol";

/// @title ElectionManager
/// @notice Top-level administrative contract deployed by INEC's Oyo State office to initialise an
///         election (Section 3.5.1). It registers the nine stakeholder categories and binds their
///         wallet addresses to administrative scopes, defines election parameters, parties and
///         candidates, models the polling-unit register (PU -> Ward -> LGA -> State) and drives the
///         four-state lifecycle Registration -> Active -> Collation -> Declared.
/// @dev    One deployment == one election. Stakeholder and geography changes are only possible in
///         the Registration phase; once Active the role map is immutable, which is what makes the
///         n-of-n party-agent threshold in PartyAgentVerification stable.
contract ElectionManager is AccessControl, IElectionManager {
    // ---------------------------------------------------------------------
    // Roles (OpenZeppelin AccessControl). INEC_ADMIN_ROLE == DEFAULT_ADMIN_ROLE.
    // ---------------------------------------------------------------------
    bytes32 public constant INEC_ADMIN_ROLE = DEFAULT_ADMIN_ROLE;
    bytes32 public constant PRESIDING_OFFICER_ROLE = keccak256("PRESIDING_OFFICER_ROLE");
    bytes32 public constant PARTY_AGENT_ROLE = keccak256("PARTY_AGENT_ROLE");
    bytes32 public constant WARD_COLLATION_OFFICER_ROLE = keccak256("WARD_COLLATION_OFFICER_ROLE");
    bytes32 public constant LGA_COLLATION_OFFICER_ROLE = keccak256("LGA_COLLATION_OFFICER_ROLE");
    bytes32 public constant STATE_RETURNING_OFFICER_ROLE = keccak256("STATE_RETURNING_OFFICER_ROLE");
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");
    bytes32 public constant RESULT_PUBLISHER_ROLE = keccak256("RESULT_PUBLISHER_ROLE");

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------
    ElectionInfo internal _info;

    address public override resultUpload;
    address public override partyAgentVerification;
    address public override collationEngine;
    address public override auditDeclaration;

    uint256 public override lgaCount;
    uint256 public override wardCount;
    uint256 public override pollingUnitCount;
    uint256 public override partyCount;
    uint256 public override candidateCount;

    mapping(uint256 => Lga) internal _lgas;
    mapping(uint256 => Ward) internal _wards;
    mapping(uint256 => PollingUnit) internal _pollingUnits;
    mapping(uint256 => Party) internal _parties;
    mapping(uint256 => Candidate) internal _candidates;

    // Officers
    mapping(uint256 => address) public override presidingOfficerOf; // puId => officer
    mapping(uint256 => address) public override wardOfficerOf; // wardId => officer
    mapping(uint256 => address) public override lgaOfficerOf; // lgaId => officer
    address public override stateReturningOfficer;
    address public override auditor;
    address public override resultPublisher;

    // Party agents: unit key => partyId => agent, plus enumeration list
    mapping(bytes32 => mapping(uint256 => address)) internal _agentFor;
    mapping(bytes32 => address[]) internal _agentsOf;

    // One stakeholder category per address (separation of duties, Section 3.4)
    mapping(address => Stakeholder) internal _stakeholders;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    event ElectionInfoSet(
        string name, string electionType, string stateName, uint64 startTime, uint64 endTime
    );
    event ModulesSet(
        address resultUpload,
        address partyAgentVerification,
        address collationEngine,
        address auditDeclaration
    );
    event PhaseChanged(T.Phase indexed from, T.Phase indexed to, uint64 timestamp);
    event LgaAdded(uint256 indexed lgaId, string name);
    event WardAdded(uint256 indexed wardId, uint256 indexed lgaId, string name);
    event PollingUnitAdded(
        uint256 indexed puId, uint256 indexed wardId, string code, string name, uint256 registeredVoters
    );
    event PollingUnitCancelled(uint256 indexed puId, string reasonCid);
    event PartyAdded(uint256 indexed partyId, string name, string acronym);
    event CandidateAdded(uint256 indexed candidateIndex, uint256 indexed partyId, string name);
    event StakeholderRegistered(
        address indexed account,
        Category indexed category,
        T.Level level,
        uint256 indexed unitId,
        uint256 partyId
    );
    event StakeholderRevoked(
        address indexed account, Category indexed category, T.Level level, uint256 unitId
    );

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------
    error AlreadyAssigned(address account, Category existing);
    error NotAssigned(address account);
    error UseRegistrationFunctions();
    error RenounceDisabled();
    error ZeroAddress();
    error AlreadyTaken(T.Level level, uint256 unitId);
    error DuplicateCandidate(uint256 partyId);
    error UnknownParty(uint256 partyId);
    error ArrayLengthMismatch();
    error ModulesAlreadySet();
    error ModulesNotSet();
    error NotReadyToActivate(string reason);
    error PollingUnitHasResult(uint256 puId);
    error AlreadyCancelled(uint256 puId);
    error InvalidTimeWindow();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------
    modifier onlyPhase(T.Phase required) {
        _requirePhase(required);
        _;
    }

    modifier onlyAdmin() {
        _checkRole(INEC_ADMIN_ROLE, msg.sender);
        _;
    }

    function _requirePhase(T.Phase required) internal view {
        if (_info.phase != required) revert T.WrongPhase(_info.phase, required);
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------
    constructor(address inecAdmin) {
        if (inecAdmin == address(0)) revert ZeroAddress();
        _grantRole(INEC_ADMIN_ROLE, inecAdmin);
        _stakeholders[inecAdmin] =
            Stakeholder({ category: Category.InecAdmin, level: T.Level.State, unitId: 0, partyId: 0 });
        _info.phase = T.Phase.Registration;
        _info.createdAt = uint64(block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Election parameters & modules
    // ---------------------------------------------------------------------
    function setElectionInfo(
        string calldata name,
        string calldata electionType,
        string calldata stateName,
        uint64 startTime,
        uint64 endTime
    ) external onlyAdmin onlyPhase(T.Phase.Registration) {
        if (endTime != 0 && endTime < startTime) revert InvalidTimeWindow();
        _info.name = name;
        _info.electionType = electionType;
        _info.stateName = stateName;
        _info.startTime = startTime;
        _info.endTime = endTime;
        emit ElectionInfoSet(name, electionType, stateName, startTime, endTime);
    }

    /// @notice Wires the four operational modules. Can only be done once, before activation.
    function setModules(address resultUpload_, address verification_, address collation_, address audit_)
        external
        onlyAdmin
        onlyPhase(T.Phase.Registration)
    {
        if (resultUpload != address(0)) revert ModulesAlreadySet();
        if (
            resultUpload_ == address(0) || verification_ == address(0) || collation_ == address(0)
                || audit_ == address(0)
        ) revert ZeroAddress();
        resultUpload = resultUpload_;
        partyAgentVerification = verification_;
        collationEngine = collation_;
        auditDeclaration = audit_;
        emit ModulesSet(resultUpload_, verification_, collation_, audit_);
    }

    function isModule(address account) public view override returns (bool) {
        return account != address(0)
            && (account == resultUpload
                || account == partyAgentVerification
                || account == collationEngine
                || account == auditDeclaration);
    }

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------
    function phase() external view override returns (T.Phase) {
        return _info.phase;
    }

    function getElectionInfo() external view returns (ElectionInfo memory) {
        return _info;
    }

    /// @notice Registration -> Active. Requires a complete configuration.
    function activateElection() external onlyAdmin onlyPhase(T.Phase.Registration) {
        if (resultUpload == address(0)) revert ModulesNotSet();
        if (lgaCount == 0 || wardCount == 0 || pollingUnitCount == 0) revert NotReadyToActivate("geography");
        if (candidateCount < 2) revert NotReadyToActivate("candidates");
        if (stateReturningOfficer == address(0)) revert NotReadyToActivate("state returning officer");
        if (auditor == address(0)) revert NotReadyToActivate("auditor");
        if (resultPublisher == address(0)) revert NotReadyToActivate("result publisher");
        _setPhase(T.Phase.Active);
    }

    /// @notice Active -> Collation. Closes the polling-unit upload window.
    function closeSubmissions() external onlyAdmin onlyPhase(T.Phase.Active) {
        _setPhase(T.Phase.Collation);
    }

    /// @notice Called by AuditDeclaration once the publisher has declared the result.
    function markDeclared() external override {
        if (msg.sender != auditDeclaration) revert T.NotAuthorised(msg.sender);
        if (_info.phase != T.Phase.Active && _info.phase != T.Phase.Collation) {
            revert T.WrongPhase(_info.phase, T.Phase.Collation);
        }
        _setPhase(T.Phase.Declared);
    }

    function _setPhase(T.Phase to) internal {
        T.Phase from = _info.phase;
        _info.phase = to;
        emit PhaseChanged(from, to, uint64(block.timestamp));
    }

    // ---------------------------------------------------------------------
    // Geography (Registration phase only)
    // ---------------------------------------------------------------------
    function addLga(string calldata name)
        public
        onlyAdmin
        onlyPhase(T.Phase.Registration)
        returns (uint256 id)
    {
        id = ++lgaCount;
        _lgas[id].id = id;
        _lgas[id].name = name;
        emit LgaAdded(id, name);
    }

    function addWard(uint256 lgaId, string calldata name)
        public
        onlyAdmin
        onlyPhase(T.Phase.Registration)
        returns (uint256 id)
    {
        if (lgaId == 0 || lgaId > lgaCount) {
            revert T.UnknownUnit(T.Level.LGA, lgaId);
        }
        id = ++wardCount;
        _wards[id].id = id;
        _wards[id].lgaId = lgaId;
        _wards[id].name = name;
        _lgas[lgaId].wardIds.push(id);
        emit WardAdded(id, lgaId, name);
    }

    function addPollingUnit(
        uint256 wardId,
        string calldata code,
        string calldata name,
        uint256 registeredVoters
    ) public onlyAdmin onlyPhase(T.Phase.Registration) returns (uint256 id) {
        if (wardId == 0 || wardId > wardCount) {
            revert T.UnknownUnit(T.Level.Ward, wardId);
        }
        id = ++pollingUnitCount;
        PollingUnit storage pu = _pollingUnits[id];
        pu.id = id;
        pu.wardId = wardId;
        pu.code = code;
        pu.name = name;
        pu.registeredVoters = registeredVoters;
        _wards[wardId].pollingUnitIds.push(id);
        emit PollingUnitAdded(id, wardId, code, name, registeredVoters);
    }

    /// @notice Batch helper used when loading INEC's polling-unit register.
    function addPollingUnits(
        uint256 wardId,
        string[] calldata codes,
        string[] calldata names,
        uint256[] calldata registeredVoters
    ) external onlyAdmin onlyPhase(T.Phase.Registration) returns (uint256 firstId, uint256 lastId) {
        if (codes.length != names.length || codes.length != registeredVoters.length) {
            revert ArrayLengthMismatch();
        }
        firstId = pollingUnitCount + 1;
        for (uint256 i = 0; i < codes.length; i++) {
            addPollingUnit(wardId, codes[i], names[i], registeredVoters[i]);
        }
        lastId = pollingUnitCount;
    }

    function addWards(uint256 lgaId, string[] calldata names)
        external
        onlyAdmin
        onlyPhase(T.Phase.Registration)
        returns (uint256 firstId, uint256 lastId)
    {
        firstId = wardCount + 1;
        for (uint256 i = 0; i < names.length; i++) {
            addWard(lgaId, names[i]);
        }
        lastId = wardCount;
    }

    /// @notice INEC may cancel a polling unit where voting did not hold (or was voided) so that its
    ///         ward can still be collated. Only possible while no figures have been uploaded.
    function cancelPollingUnit(uint256 puId, string calldata reasonCid) external onlyAdmin {
        if (_info.phase != T.Phase.Active && _info.phase != T.Phase.Collation) {
            revert T.WrongPhase(_info.phase, T.Phase.Active);
        }
        PollingUnit storage pu = _pollingUnits[puId];
        if (pu.id == 0) revert T.UnknownUnit(T.Level.PollingUnit, puId);
        if (pu.cancelled) revert AlreadyCancelled(puId);
        if (
            IPartyAgentVerification(partyAgentVerification).statusOf(T.Level.PollingUnit, puId)
                != T.ResultStatus.Open
        ) revert PollingUnitHasResult(puId);
        pu.cancelled = true;
        pu.cancellationCid = reasonCid;
        emit PollingUnitCancelled(puId, reasonCid);
    }

    // ---------------------------------------------------------------------
    // Parties & candidates (Registration phase only)
    // ---------------------------------------------------------------------
    function addParty(string calldata name, string calldata acronym)
        external
        onlyAdmin
        onlyPhase(T.Phase.Registration)
        returns (uint256 id)
    {
        id = ++partyCount;
        _parties[id] = Party({ id: id, name: name, acronym: acronym, hasCandidate: false, candidateIndex: 0 });
        emit PartyAdded(id, name, acronym);
    }

    /// @notice Registers the candidate sponsored by `partyId`. Candidate indexes are 0-based and
    ///         define the order of the `candidateVotes` array in every result submission.
    function addCandidate(uint256 partyId, string calldata name)
        external
        onlyAdmin
        onlyPhase(T.Phase.Registration)
        returns (uint256 index)
    {
        if (partyId == 0 || partyId > partyCount) revert UnknownParty(partyId);
        Party storage p = _parties[partyId];
        if (p.hasCandidate) revert DuplicateCandidate(partyId);
        index = candidateCount++;
        _candidates[index] = Candidate({ index: index, partyId: partyId, name: name });
        p.hasCandidate = true;
        p.candidateIndex = index;
        emit CandidateAdded(index, partyId, name);
    }

    // ---------------------------------------------------------------------
    // Stakeholder registration (Registration phase only)
    // ---------------------------------------------------------------------
    function registerPresidingOfficer(address account, uint256 puId)
        external
        onlyAdmin
        onlyPhase(T.Phase.Registration)
    {
        if (puId == 0 || puId > pollingUnitCount) revert T.UnknownUnit(T.Level.PollingUnit, puId);
        if (presidingOfficerOf[puId] != address(0)) revert AlreadyTaken(T.Level.PollingUnit, puId);
        _assign(account, PRESIDING_OFFICER_ROLE, Category.PresidingOfficer, T.Level.PollingUnit, puId, 0);
        presidingOfficerOf[puId] = account;
    }

    function registerWardCollationOfficer(address account, uint256 wardId)
        external
        onlyAdmin
        onlyPhase(T.Phase.Registration)
    {
        if (wardId == 0 || wardId > wardCount) revert T.UnknownUnit(T.Level.Ward, wardId);
        if (wardOfficerOf[wardId] != address(0)) revert AlreadyTaken(T.Level.Ward, wardId);
        _assign(account, WARD_COLLATION_OFFICER_ROLE, Category.WardCollationOfficer, T.Level.Ward, wardId, 0);
        wardOfficerOf[wardId] = account;
    }

    function registerLgaCollationOfficer(address account, uint256 lgaId)
        external
        onlyAdmin
        onlyPhase(T.Phase.Registration)
    {
        if (lgaId == 0 || lgaId > lgaCount) revert T.UnknownUnit(T.Level.LGA, lgaId);
        if (lgaOfficerOf[lgaId] != address(0)) revert AlreadyTaken(T.Level.LGA, lgaId);
        _assign(account, LGA_COLLATION_OFFICER_ROLE, Category.LgaCollationOfficer, T.Level.LGA, lgaId, 0);
        lgaOfficerOf[lgaId] = account;
    }

    function registerStateReturningOfficer(address account)
        external
        onlyAdmin
        onlyPhase(T.Phase.Registration)
    {
        if (stateReturningOfficer != address(0)) {
            revert AlreadyTaken(T.Level.State, T.STATE_UNIT_ID);
        }
        _assign(
            account,
            STATE_RETURNING_OFFICER_ROLE,
            Category.StateReturningOfficer,
            T.Level.State,
            T.STATE_UNIT_ID,
            0
        );
        stateReturningOfficer = account;
    }

    function registerAuditor(address account) external onlyAdmin onlyPhase(T.Phase.Registration) {
        if (auditor != address(0)) revert AlreadyTaken(T.Level.State, T.STATE_UNIT_ID);
        _assign(account, AUDITOR_ROLE, Category.Auditor, T.Level.State, T.STATE_UNIT_ID, 0);
        auditor = account;
    }

    function registerResultPublisher(address account) external onlyAdmin onlyPhase(T.Phase.Registration) {
        if (resultPublisher != address(0)) revert AlreadyTaken(T.Level.State, T.STATE_UNIT_ID);
        _assign(account, RESULT_PUBLISHER_ROLE, Category.ResultPublisher, T.Level.State, T.STATE_UNIT_ID, 0);
        resultPublisher = account;
    }

    /// @notice Registers a party agent for one party at one unit of one level. One agent per party
    ///         per unit; the number of registered agents at a unit is the n in the n-of-n threshold.
    function registerPartyAgent(address account, uint256 partyId, T.Level level, uint256 unitId)
        public
        onlyAdmin
        onlyPhase(T.Phase.Registration)
    {
        if (partyId == 0 || partyId > partyCount) revert UnknownParty(partyId);
        if (!unitExists(level, unitId)) revert T.UnknownUnit(level, unitId);
        bytes32 k = T.key(level, unitId);
        if (_agentFor[k][partyId] != address(0)) revert AlreadyTaken(level, unitId);
        _assign(account, PARTY_AGENT_ROLE, Category.PartyAgent, level, unitId, partyId);
        _agentFor[k][partyId] = account;
        _agentsOf[k].push(account);
    }

    function registerPartyAgents(
        address[] calldata accounts,
        uint256[] calldata partyIds,
        T.Level level,
        uint256[] calldata unitIds
    ) external onlyAdmin onlyPhase(T.Phase.Registration) {
        if (accounts.length != partyIds.length || accounts.length != unitIds.length) {
            revert ArrayLengthMismatch();
        }
        for (uint256 i = 0; i < accounts.length; i++) {
            registerPartyAgent(accounts[i], partyIds[i], level, unitIds[i]);
        }
    }

    /// @notice Removes any stakeholder (except the INEC admin) during the Registration phase.
    function revokeStakeholder(address account) external onlyAdmin onlyPhase(T.Phase.Registration) {
        Stakeholder memory s = _stakeholders[account];
        if (s.category == Category.None || s.category == Category.InecAdmin) revert NotAssigned(account);

        if (s.category == Category.PresidingOfficer) {
            delete presidingOfficerOf[s.unitId];
            _revokeRole(PRESIDING_OFFICER_ROLE, account);
        } else if (s.category == Category.WardCollationOfficer) {
            delete wardOfficerOf[s.unitId];
            _revokeRole(WARD_COLLATION_OFFICER_ROLE, account);
        } else if (s.category == Category.LgaCollationOfficer) {
            delete lgaOfficerOf[s.unitId];
            _revokeRole(LGA_COLLATION_OFFICER_ROLE, account);
        } else if (s.category == Category.StateReturningOfficer) {
            stateReturningOfficer = address(0);
            _revokeRole(STATE_RETURNING_OFFICER_ROLE, account);
        } else if (s.category == Category.Auditor) {
            auditor = address(0);
            _revokeRole(AUDITOR_ROLE, account);
        } else if (s.category == Category.ResultPublisher) {
            resultPublisher = address(0);
            _revokeRole(RESULT_PUBLISHER_ROLE, account);
        } else if (s.category == Category.PartyAgent) {
            bytes32 k = T.key(s.level, s.unitId);
            delete _agentFor[k][s.partyId];
            address[] storage list = _agentsOf[k];
            for (uint256 i = 0; i < list.length; i++) {
                if (list[i] == account) {
                    list[i] = list[list.length - 1];
                    list.pop();
                    break;
                }
            }
            _revokeRole(PARTY_AGENT_ROLE, account);
        }
        delete _stakeholders[account];
        emit StakeholderRevoked(account, s.category, s.level, s.unitId);
    }

    function _assign(
        address account,
        bytes32 role,
        Category category,
        T.Level level,
        uint256 unitId,
        uint256 partyId
    ) internal {
        if (account == address(0)) revert ZeroAddress();
        Category existing = _stakeholders[account].category;
        if (existing != Category.None) revert AlreadyAssigned(account, existing);
        _stakeholders[account] =
            Stakeholder({ category: category, level: level, unitId: unitId, partyId: partyId });
        _grantRole(role, account);
        emit StakeholderRegistered(account, category, level, unitId, partyId);
    }

    // ---------------------------------------------------------------------
    // AccessControl hardening: roles are only granted through the registration functions above
    // so that every role holder carries an administrative scope, and stakeholders cannot silently
    // drop out of the n-of-n signing set by renouncing.
    // ---------------------------------------------------------------------
    function grantRole(bytes32 role, address account) public override onlyRole(getRoleAdmin(role)) {
        if (role != INEC_ADMIN_ROLE) revert UseRegistrationFunctions();
        if (_stakeholders[account].category != Category.None) {
            revert AlreadyAssigned(account, _stakeholders[account].category);
        }
        _stakeholders[account] =
            Stakeholder({ category: Category.InecAdmin, level: T.Level.State, unitId: 0, partyId: 0 });
        _grantRole(role, account);
    }

    function revokeRole(bytes32 role, address account) public override onlyRole(getRoleAdmin(role)) {
        if (role != INEC_ADMIN_ROLE) revert UseRegistrationFunctions();
        if (_info.phase != T.Phase.Registration) revert T.WrongPhase(_info.phase, T.Phase.Registration);
        delete _stakeholders[account];
        _revokeRole(role, account);
    }

    function renounceRole(bytes32, address) public pure override {
        revert RenounceDisabled();
    }

    // ---------------------------------------------------------------------
    // Views used by the other modules and the portals
    // ---------------------------------------------------------------------
    function getLga(uint256 lgaId) external view override returns (Lga memory) {
        return _lgas[lgaId];
    }

    function getWard(uint256 wardId) external view override returns (Ward memory) {
        return _wards[wardId];
    }

    function getPollingUnit(uint256 puId) external view override returns (PollingUnit memory) {
        return _pollingUnits[puId];
    }

    function getParty(uint256 partyId) external view override returns (Party memory) {
        return _parties[partyId];
    }

    function getCandidate(uint256 index) external view override returns (Candidate memory) {
        return _candidates[index];
    }

    function getCandidates() external view returns (Candidate[] memory list) {
        list = new Candidate[](candidateCount);
        for (uint256 i = 0; i < candidateCount; i++) {
            list[i] = _candidates[i];
        }
    }

    function wardIdsOf(uint256 lgaId) external view override returns (uint256[] memory) {
        return _lgas[lgaId].wardIds;
    }

    function pollingUnitIdsOf(uint256 wardId) external view override returns (uint256[] memory) {
        return _wards[wardId].pollingUnitIds;
    }

    function isPollingUnitCancelled(uint256 puId) external view override returns (bool) {
        return _pollingUnits[puId].cancelled;
    }

    function registeredVotersOf(uint256 puId) external view override returns (uint256) {
        return _pollingUnits[puId].registeredVoters;
    }

    function unitExists(T.Level level, uint256 unitId) public view override returns (bool) {
        if (level == T.Level.PollingUnit) return unitId != 0 && unitId <= pollingUnitCount;
        if (level == T.Level.Ward) return unitId != 0 && unitId <= wardCount;
        if (level == T.Level.LGA) return unitId != 0 && unitId <= lgaCount;
        return unitId == T.STATE_UNIT_ID;
    }

    /// @notice The officer responsible for a unit: presiding officer (PU), ward collation officer,
    ///         LGA collation officer or the state returning officer.
    function isOfficerFor(T.Level level, uint256 unitId, address account)
        external
        view
        override
        returns (bool)
    {
        if (account == address(0)) return false;
        if (level == T.Level.PollingUnit) return presidingOfficerOf[unitId] == account;
        if (level == T.Level.Ward) return wardOfficerOf[unitId] == account;
        if (level == T.Level.LGA) return lgaOfficerOf[unitId] == account;
        return unitId == T.STATE_UNIT_ID && stateReturningOfficer == account;
    }

    function isAgentFor(T.Level level, uint256 unitId, address account)
        external
        view
        override
        returns (bool ok, uint256 partyId)
    {
        Stakeholder memory s = _stakeholders[account];
        if (s.category != Category.PartyAgent || s.level != level || s.unitId != unitId) return (false, 0);
        return (true, s.partyId);
    }

    function agentCount(T.Level level, uint256 unitId) external view override returns (uint256) {
        return _agentsOf[T.key(level, unitId)].length;
    }

    function agentsOf(T.Level level, uint256 unitId) external view override returns (address[] memory) {
        return _agentsOf[T.key(level, unitId)];
    }

    function agentOfParty(T.Level level, uint256 unitId, uint256 partyId) external view returns (address) {
        return _agentFor[T.key(level, unitId)][partyId];
    }

    function stakeholderOf(address account) external view override returns (Stakeholder memory) {
        return _stakeholders[account];
    }
}

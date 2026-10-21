# Smart-contract API reference

Solidity 0.8.28 · OpenZeppelin Contracts 5.x · one deployment = one election. Enum values are listed in
`contracts/src/VoteChainTypes.sol`; the same names are used by the backend (`chain.js`) and frontend
(`constants.js`).

Enums: `Level {PollingUnit, Ward, LGA, State}` · `Phase {Registration, Active, Collation, Declared}` ·
`ResultStatus {Open, PendingSignatures, Frozen, Resolved, Escalated, Approved, Declared}` ·
`DisputeStatus {Raised, Resolved, Accepted, Escalated, RuledDismissed, RuledUpheld}` ·
`ResolutionType {None, ConfirmedOriginal, FiguresCorrected}` ·
`Rule {None, CastExceedsAccredited, CastExceedsRegistered, ValidPlusRejectedMismatch, CandidateSumMismatch, AccreditedExceedsRegistered, CollationMismatch, RegisterMismatch}` ·
`Field {RegisteredVoters, AccreditedVoters, TotalVotesCast, ValidVotes, RejectedVotes, CandidateVotes}`.
The state-level unit id is always `1`.

## ElectionManager

| Function | Caller | Phase | Purpose |
|---|---|---|---|
| `setElectionInfo(name, type, state, start, end)` | INEC admin | Registration | election parameters |
| `setModules(upload, verification, collation, audit)` | INEC admin | Registration (once) | wire the modules |
| `addLga(name)` / `addWards(lgaId, names[])` / `addWard(lgaId, name)` | INEC admin | Registration | geography |
| `addPollingUnit(wardId, code, name, registeredVoters)` / `addPollingUnits(wardId, codes[], names[], registered[])` | INEC admin | Registration | polling-unit register |
| `addParty(name, acronym)` / `addCandidate(partyId, name)` | INEC admin | Registration | one candidate per party; candidate index = `candidateVotes` position |
| `registerPresidingOfficer(addr, puId)` · `registerWardCollationOfficer(addr, wardId)` · `registerLgaCollationOfficer(addr, lgaId)` · `registerStateReturningOfficer(addr)` · `registerAuditor(addr)` · `registerResultPublisher(addr)` | INEC admin | Registration | one category per address |
| `registerPartyAgent(addr, partyId, level, unitId)` / `registerPartyAgents(addrs[], partyIds[], level, unitIds[])` | INEC admin | Registration | one agent per party per unit |
| `revokeStakeholder(addr)` | INEC admin | Registration | remove any non-admin stakeholder |
| `activateElection()` | INEC admin | Registration→Active | requires modules, geography, ≥2 candidates, SRO, auditor, publisher |
| `closeSubmissions()` | INEC admin | Active→Collation | closes first-time EC8A uploads |
| `cancelPollingUnit(puId, reasonCid)` | INEC admin | Active/Collation | only while the unit has no figures |
| `markDeclared()` | AuditDeclaration module | → Declared | called from `declareResult` |
| `grantRole` / `revokeRole` | INEC admin | Registration | only `DEFAULT_ADMIN_ROLE`; other roles revert `UseRegistrationFunctions` |
| `renounceRole` | — | — | always reverts `RenounceDisabled` |

Views: `phase()`, `getElectionInfo()`, `lgaCount/wardCount/pollingUnitCount/partyCount/candidateCount`,
`getLga/getWard/getPollingUnit/getParty/getCandidate/getCandidates`, `wardIdsOf`, `pollingUnitIdsOf`,
`isPollingUnitCancelled`, `registeredVotersOf`, `unitExists`, `presidingOfficerOf`, `wardOfficerOf`,
`lgaOfficerOf`, `stateReturningOfficer`, `auditor`, `resultPublisher`, `isOfficerFor(level, unit, addr)`,
`isAgentFor(level, unit, addr) → (bool, partyId)`, `agentCount`, `agentsOf`, `agentOfParty`,
`stakeholderOf(addr) → {category, level, unitId, partyId}`, `isModule`, `resultUpload()`,
`partyAgentVerification()`, `collationEngine()`, `auditDeclaration()`.

Events: `ElectionInfoSet`, `ModulesSet`, `PhaseChanged(from, to, ts)`, `LgaAdded`, `WardAdded`,
`PollingUnitAdded`, `PollingUnitCancelled`, `PartyAdded`, `CandidateAdded`,
`StakeholderRegistered(account, category, level, unitId, partyId)`, `StakeholderRevoked`.

Errors: `AlreadyAssigned(addr, category)`, `NotAssigned`, `UseRegistrationFunctions`, `RenounceDisabled`,
`ZeroAddress`, `AlreadyTaken(level, unit)`, `DuplicateCandidate`, `UnknownParty`, `ArrayLengthMismatch`,
`ModulesAlreadySet`, `ModulesNotSet`, `NotReadyToActivate(reason)`, `PollingUnitHasResult`,
`AlreadyCancelled`, `InvalidTimeWindow`, plus shared `WrongPhase(current, required)`, `UnknownUnit`,
`NotAuthorised`, and OpenZeppelin's `AccessControlUnauthorizedAccount`.

## ResultUpload (EC8A)

| Function | Caller | Purpose |
|---|---|---|
| `submitResult(puId, Figures, formCid)` | presiding officer of `puId`, phase Active, status Open | runs the six checks + register cross-check atomically, stores figures/CID/block/timestamp, opens signing round 1, emits `ResultSubmitted` |
| `resubmitResult(puId, Figures, formCid)` | presiding officer, status Frozen | corrected figures → resolves the active dispute as `FiguresCorrected`, new round (`ResultResubmitted`) |
| `validateFigures(puId, Figures) → (rule, expected, actual)` | anyone (view) | same checks for instant portal feedback |
| `getResult(puId)`, `getFigures(puId)`, `figuresHashOf(puId)`, `hasResult(puId)`, `submissionCount()` | view | |

Errors: `ValidationFailed(rule, expected, actual)`, `NotPresidingOfficer(addr, puId)`, `PollingUnitCancelled`,
`EmptyFormCid`, shared `WrongPhase`, `InvalidStatus(level, unit, current)`, `UnknownUnit`.

## PartyAgentVerification

| Function | Caller | Precondition | Effect |
|---|---|---|---|
| `signResult(level, unitId, figuresHash)` | agent of that unit | PendingSignatures, hash current, not yet signed | records signature; Approved when every registered agent has signed |
| `signWithObjection(level, unitId, figuresHash, reason)` | agent | as above, reason non-empty | signature + permanent `ObjectionRecorded` |
| `raiseDispute(level, unitId, reason, evidenceCid) → disputeId` | agent who has not signed this round | PendingSignatures | status → Frozen, `DisputeRaised` |
| `resolveDispute(level, unitId, disputeId, documentCid, note)` | officer for the unit | Frozen, active dispute, not `requiresCorrection` | `ConfirmedOriginal`; new round; status → Resolved |
| `acceptResolution(disputeId)` | disputing agent | dispute Resolved | status → PendingSignatures (all agents re-sign) |
| `escalateDispute(disputeId)` | disputing agent | dispute Resolved | status → Escalated, `pendingEscalations++` |
| `ruleOnEscalation(disputeId, upheld, documentCid)` | auditor | dispute Escalated | upheld → Frozen + `requiresCorrection`; dismissed → PendingSignatures with the disputer's slot waived |
| `openSignatureRound(level, unitId, hash)` | ResultUpload (PU) / CollationEngine (others) | Open | round 1 |
| `correctFigures(level, unitId, newHash, officer)` | module | Frozen with active dispute | `FiguresCorrected`, new round, Resolved |
| `markDeclared(level, unitId)` | AuditDeclaration | Approved | Declared |

Views: `statusOf`, `isApproved`, `currentFiguresHash`, `getRecord → {status, round, signatureCount,
figuresHash, activeDisputeId, openedAt, approvedAt}`, `requiredSignatures`, `getSignature(level, unit,
round, agent)`, `signersOf(level, unit, round)`, `signingProgress(level, unit) → (agents[], signed[],
objections[], waived[])`, `disputeCount`, `getDispute(id)`, `disputeIdsOf(level, unit)`,
`escalatedDisputeIds`, `pendingEscalations`.

Events: `StatusChanged(level, unit, from, to)`, `SignatureRoundOpened(level, unit, round, hash)`,
`ResultSigned(level, unit, round, agent, partyId, hash, objection)`, `ObjectionRecorded`,
`ResultApproved(level, unit, round, signatures, ts)`, `DisputeRaised(id, level, unit, round, agent,
partyId, reason, evidenceCid)`, `DisputeResolved(id, kind, resolvedBy, documentCid, newRound)`,
`ResolutionAccepted`, `DisputeEscalated`, `EscalationRuled(id, auditor, upheld, documentCid)`,
`SignatureWaived(level, unit, round, agent, disputeId)`.

Errors: `NotAgentForUnit`, `NotOfficerForUnit`, `NotDisputingAgent`, `NotAuditor`, `AlreadySigned`,
`StaleFiguresHash(expected, provided)`, `CannotDisputeAfterSigning`, `EmptyReason`, `NoActiveDispute`,
`WrongDispute`, `InvalidDisputeStatus`, `CorrectionRequired`, `UnknownDispute`, `NotOperational(phase)`,
shared `InvalidStatus`, `NotAuthorised`.

## CollationEngine (EC8B / EC8C / EC8D)

| Function | Caller | Purpose |
|---|---|---|
| `computeAggregate(level, unitId) → (Figures, complete, blockingUnitId)` | view | Σ of approved lower-level results (cancelled PUs skipped) |
| `confirmCollation(level, unitId, Figures declared, formCid) → bool` | officer for the unit; status Open (first) or Frozen (correction); phase Active/Collation | declared == aggregate → stored + signing round; otherwise `MismatchAlert` recorded, returns false, collation stays blocked |
| `checkDeclared(level, unitId, Figures) → (ok, field, candidateIndex, declared, computed)` | view | pre-check for the portal |
| `verifyConsistency(level, unitId) → (consistent, field, candidateIndex, stored, computed)` | view (public) | recomputes a confirmed collation from the level below |
| `getCollation`, `getFigures`, `figuresHashOf`, `mismatchAttemptsOf` | view | |

Events: `CollationConfirmed(level, unit, round, officer, hash, formCid, ts)`,
`MismatchAlert(level, unit, officer, field, candidateIndex, declared, computed, attempt)`.
Errors: `NotCollationOfficer`, `InvalidCollationLevel`, `LowerLevelNotApproved(lowerLevel, unitId,
status)`, `EmptyFormCid`, `NotOperational`, shared `InvalidStatus`, `UnknownUnit`.

## AuditDeclaration

| Function | Caller | Purpose |
|---|---|---|
| `stateResultHash()` | view | current hash of the approved state figures |
| `auditDigest()` | view | `keccak256(abi.encode("VoteChain.AuditApproval", chainId, address(this), stateResultHash()))` — signed with `personal_sign` (EIP-191) |
| `isReadyForAudit() → (ready, reason)` | view | state Approved, no pending escalations, not yet audited |
| `verifyAndSign(signature, reportCid)` | anyone (the signature is the authorisation) | recovers the signer with `ECDSA.recover(toEthSignedMessageHash(auditDigest()))`; must equal `election.auditor()`; sets `auditApproved` |
| `declareResult()` | result publisher | requires `auditApproved`, hash unchanged, not declared; computes winner (tie flagged), marks state Declared and the election Declared |
| `auditApproved()`, `getAudit()`, `isDeclared()`, `getDeclaration()`, `escalatedDisputes()` | view | |

Events: `AuditApproved(auditor, stateResultHash, reportCid, ts)`, `ResultDeclared(publisher, hash,
winnerCandidateIndex, winnerPartyId, winnerVotes, tie, ts)`.
Errors: `StateResultNotApproved(status)`, `PendingEscalations(count)`, `AlreadyAudited`,
`NotAuditorSignature(recovered, expected)`, `AuditNotApproved`, `AlreadyDeclared`, `NotResultPublisher`,
`StateResultChanged`, and OpenZeppelin's `ECDSAInvalidSignature*`.

## Off-chain hash helpers

```js
// hardhat/lib.js and frontend/src/lib/figures.js
figuresHash(level, unitId, figures, formCid) ==
  keccak256(abi.encode(uint8 level, uint256 unitId, uint256 registered, uint256 accredited,
                       uint256 cast, uint256 valid, uint256 rejected, uint256[] candidateVotes, string formCid))
```

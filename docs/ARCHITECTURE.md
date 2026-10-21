# VoteChain — implementation architecture

This document maps the Chapter 3 design onto the code: the four layers, the five smart-contract modules,
the on-chain data model, the result/dispute state machine, and the off-chain services.

## 1. Four-layer architecture (Figure 3.1)

```
┌───────────────────────────────────────────────────────────────────────────┐
│ 3. Application layer — frontend/ (React 18 + Vite + ethers v6 + MetaMask)  │
│    role-driven portals; every write is a wallet-signed transaction         │
├───────────────────────────────────────────────────────────────────────────┤
│ 4. Storage layer — backend/ (Node/Express)                                 │
│    IPFS pipeline (local | Kubo | Pinata) · PostgreSQL cache · indexer ·     │
│    notifications · sessions · DID-style credentials · REST read model      │
├───────────────────────────────────────────────────────────────────────────┤
│ 2. Smart-contract layer — contracts/src (Solidity 0.8.28, OpenZeppelin 5)  │
│    ElectionManager · ResultUpload · PartyAgentVerification ·               │
│    CollationEngine · AuditDeclaration                                      │
├───────────────────────────────────────────────────────────────────────────┤
│ 1. Blockchain layer — Hardhat node / Anvil (dev), Sepolia (evaluation)     │
└───────────────────────────────────────────────────────────────────────────┘
```

The blockchain is the only authoritative record. The backend is a *read model*: it reads the contracts
(directly for detail views; through an event indexer for lists, feeds and notifications) and pins files
to IPFS. It never holds a private key and cannot change electoral state — the Voatz lesson from Chapter 2
(no trust in centralised servers) is built in.

## 2. Module interaction (Figure 3.4)

```
                 registers officers/agents, parameters, lifecycle
                  ┌──────────────────────────────────────────────┐
                  │              ElectionManager                 │
                  │  roles · geography · parties · phase         │
                  └───────┬───────────────┬──────────────┬───────┘
      isOfficerFor/agentsOf│               │ isAgentFor   │ auditor / publisher
                          ▼               ▼              ▼
   ┌──────────────┐ openSignatureRound ┌──────────────────────┐   ┌──────────────────┐
   │ ResultUpload │──────────────────▶│PartyAgentVerification│◀──│ AuditDeclaration │
   │  EC8A, 6 rules│  correctFigures   │ n-of-n signing        │   │ verifyAndSign    │
   └──────┬───────┘                   │ dispute state machine │   │ declareResult    │
          │ getFigures                 └──────────┬───────────┘   └────────┬─────────┘
          ▼                                       │ isApproved              │ getFigures(State)
   ┌──────────────────────────────────────────────▼─────────────────────────┴───┐
   │ CollationEngine — Σ approved lower level, exact-match check, MismatchAlert │
   └────────────────────────────────────────────────────────────────────────────┘
```

* `PartyAgentVerification` owns the **status registry** for every result unit `(level, unitId)`; the
  other modules open or correct signing rounds through module-only hooks (`onlyModuleFor`).
* `CollationEngine` only reads results in `Approved` status from the level directly below — the
  mechanism that makes level-skipping impossible.
* `AuditDeclaration` reads the approved state figures hash from the registry, verifies the auditor's
  ECDSA signature over it, and calls `ElectionManager.markDeclared()` at the end.

Deployment order: ElectionManager → PartyAgentVerification → ResultUpload → CollationEngine →
AuditDeclaration → `ElectionManager.setModules(...)` (once, in the Registration phase).

## 3. On-chain data model

```solidity
struct Figures {                 // identical at every level
    uint256 registeredVoters;
    uint256 accreditedVoters;
    uint256 totalVotesCast;
    uint256 validVotes;
    uint256 rejectedVotes;
    uint256[] candidateVotes;    // index = candidate index (0-based, one candidate per party)
}
```

| Record | Where | Key | Content |
|---|---|---|---|
| Polling-unit result (EC8A) | ResultUpload | `puId` | figures, form CID, officer, timestamp, block, `figuresHash`, round |
| Collation (EC8B/C/D) | CollationEngine | `(level, unitId)` | figures, form CID, officer, timestamp, block, `figuresHash`, round, `mismatchAttempts` |
| Result status | PartyAgentVerification | `(level, unitId)` | status, round, signatureCount, figuresHash, activeDisputeId, timestamps |
| Signature | PartyAgentVerification | `(level, unitId, round, agent)` | signed, objection(+reason), waived, figuresHash, timestamp, block |
| Dispute | PartyAgentVerification | `disputeId` | agent, party, round, reason, evidence CID, status, resolution{kind, officer, doc CID, note, times}, ruling{upheld, doc CID, time}, requiresCorrection |
| Audit | AuditDeclaration | singleton | auditor, stateResultHash, signature bytes, report CID, timestamp |
| Declaration | AuditDeclaration | singleton | publisher, figures, winner, tie flag, timestamp, block |
| Geography / roles | ElectionManager | ids / addresses | LGAs→wards→PUs (code, name, register), parties, candidates, one stakeholder category per address with its scope |

**Figures hash.** `keccak256(abi.encode(level, unitId, registered, accredited, cast, valid, rejected,
candidateVotes, formCid))`. Party-agent signatures reference it, so each signature is bound to the exact
figures *and* the exact form scan the agent reviewed. The portals recompute it locally and show an
integrity badge; the backend indexer and Hardhat tests use the same function (`hardhat/lib.js`,
`frontend/src/lib/figures.js`).

## 4. Result / dispute state machine (Figure 3.3)

```
            submit / confirm                 all agents sign (n-of-n)
   Open ───────────────────▶ PendingSignatures ───────────────────▶ Approved ──▶ (state only) Declared
                                  │  ▲       ▲                                     ▲
                    raiseDispute  │  │ accept│ resolution                          │ declareResult
                                  ▼  │       │                                     │ (requires audit)
                               Frozen ──────▶ Resolved ────escalate────▶ Escalated
                          officer resolves:   (agent must accept          │ auditor rules
                          • confirm original   or escalate)               │ dismiss → PendingSignatures
                          • correct figures                               │           (disputer waived)
                            (new hash)                                    └ uphold → Frozen (correction required)
```

Rules enforced in `PartyAgentVerification`:

1. **Approval threshold** — `Approved` only when `signatureCount == agentCount(level, unitId)`; there is no
   majority path and a unit with no accredited agents can never be approved.
2. **Dispute freeze** — one active dispute at a time; `Frozen`/`Resolved`/`Escalated` results are invisible
   to the level above (`isApproved == false`).
3. **Re-signing** — every resolution (confirmation or correction) increments the round and clears the
   count, so all agents sign the confirmed or corrected figures again.
4. **Objection ≠ dispute** — `signWithObjection` counts toward the threshold but records the objection
   permanently (Section 3.6: figures tally, agent still objects, collation continues).
5. **Deadlock safety** — an escalated dispute that the auditor *dismisses* waives that agent's slot for
   the current round; one the auditor *upholds* returns the unit to `Frozen` and only a corrected-figures
   resolution is accepted (`CorrectionRequired`).

## 5. Validation rules (Table 3.2)

`VoteChainTypes.checkFigures` evaluates rules 1–5 in table order and returns the first violation with the
expected bound and the offending value; `ResultUpload.submitResult` reverts with
`ValidationFailed(rule, expected, actual)`. Rule 6 (collated total ≠ sum of lower level) lives in
`CollationEngine.confirmCollation`, which **records** a `MismatchAlert(level, unit, officer, field,
candidateIndex, declared, computed, attempt)` instead of reverting, so an attempted alteration leaves
permanent evidence while the collation stays blocked. A seventh *register cross-check* rejects a
registered-voters figure that differs from INEC's polling-unit register when one was loaded.

## 6. Roles and least privilege (Table 3.1)

| Category (`ElectionManager.Category`) | Scope | Can |
|---|---|---|
| InecAdmin | election | configure (Registration only), activate, close uploads, cancel a PU. Cannot upload, sign, collate, audit or declare. |
| PresidingOfficer | one PU | `submitResult`, `resubmitResult` (when Frozen), `resolveDispute` for that PU |
| PartyAgent | one unit of one level for one party | `signResult`, `signWithObjection`, `raiseDispute`, `acceptResolution`, `escalateDispute` for that unit |
| WardCollationOfficer / LgaCollationOfficer / StateReturningOfficer | one ward / LGA / the state | `confirmCollation`, `resolveDispute` for that unit |
| Auditor | state | `ruleOnEscalation`, sign the audit digest (`verifyAndSign` accepts only that signature) |
| ResultPublisher | state | `declareResult` (only after `auditApproved`) |
| Public | — | every view function; nothing else |

One address holds at most one category (`AlreadyAssigned`), `grantRole`/`renounceRole` bypasses are
disabled, and the role map freezes when the election becomes Active.

## 7. Off-chain services (backend/)

* **IPFS pipeline** — `POST /api/ipfs/upload` pins a scan and returns the CID the portal puts on-chain;
  `GET /api/ipfs/:cid` serves it. Providers: `local` (content-addressed disk store with real CIDv1
  identifiers, zero dependencies), `kubo` (docker compose), `pinata`.
* **Indexer** — polls `eth_getLogs` for the five contracts from the deployment block, decodes with the
  ABIs and upserts into PostgreSQL (`chain_events`, `stakeholders`, geography, `unit_status`, `results`,
  `signatures`, `disputes`, `mismatch_alerts`, `audit_record`, `declaration`). Idempotent — the cache can
  be dropped and rebuilt.
* **Notifications** — derived from events plus the stakeholder scope table (e.g. `ResultSubmitted` → the
  PU's agents; `DisputeRaised` → the unit's officer and the other agents; `MismatchAlert` → agents, auditor,
  INEC; `StateApproved` → auditor). Read through wallet-authenticated sessions (`/api/auth/*`).
* **Credentials** — DID-style (`did:ethr:<chainId>:<address>`) credentials signed by an INEC admin wallet
  and verified against both the signature and the live on-chain role (Section 2.2.4).
* **Read model** — `/api/election`, `/api/election/geography`, `/api/units/:level/:id`, `/api/disputes`,
  `/api/audit`, `/api/chain` (full trace), `/api/verify/:level/:id`, `/api/stakeholders/:address`,
  validation pre-checks (`/validate`, `/check-collation`).

## 8. Frontend (frontend/)

`useApp` holds the backend config, the connected wallet (MetaMask via `BrowserProvider`, or a demo key on
a local node), the wallet's on-chain role, the election summary and a `sendTx` helper that decodes custom
errors from all five ABIs into readable messages. `App.jsx` maps the role category to a portal:

| Portal | Component | Highlights |
|---|---|---|
| Public verification | `PublicPortal` | geography tree with live statuses, unit inspector, recomputed-sum comparison, declared result |
| INEC Admin | `AdminPortal` | lifecycle, geography, parties/candidates, stakeholder registration, PU cancellation, credential issuance |
| Presiding Officer | `PresidingOfficerPortal` | EC8A form with live six-rule check, IPFS upload, resubmission when Frozen |
| Party Agent | `PartyAgentPortal` | sign / sign with objection / dispute with evidence; accept or escalate resolutions |
| Ward / LGA / State officers | `CollationOfficerPortal` | lower-level status table, contract-computed aggregate, declared-totals form with mismatch pre-check |
| Auditor | `AuditorPortal` | readiness checklist, escalated-dispute rulings, full chain trace, EIP-191 signature + `verifyAndSign` |
| Publisher | `PublisherPortal` | declaration gate and `declareResult` |

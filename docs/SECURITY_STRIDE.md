# Security evaluation — STRIDE threat model and static analysis

Section 3.11.1 calls for STRIDE threat modelling of the complete architecture and Slither static analysis
of the five contracts. This document records the threat model against the implementation and gives the
Slither procedure; the Slither report itself is produced when the tool is run (see the end).

## 1. Assets and trust boundaries

| Asset | Where | Guardian |
|---|---|---|
| Result figures at every level | contracts | rules 1–6, n-of-n signatures, hierarchical aggregation |
| Party-agent signatures | PartyAgentVerification | wallet keys (MetaMask), hash binding |
| Dispute and resolution records | PartyAgentVerification | role checks, one active dispute, auditor rulings |
| Auditor verification | AuditDeclaration | `ecrecover` of the auditor's ECDSA signature over the state hash |
| Final declaration | AuditDeclaration | `require(auditApproved)` |
| Scanned forms / evidence / reports | IPFS | content addressing — CID recorded on-chain |
| Role registry | ElectionManager | INEC admin during Registration only, frozen afterwards |

Trust boundaries: (a) wallet ↔ portal (browser), (b) portal ↔ backend (HTTPS/REST), (c) backend ↔ chain
(RPC, read-only), (d) wallet ↔ chain (signed transactions), (e) backend ↔ IPFS provider.

## 2. STRIDE analysis

| # | Threat | Category | Attack | Mitigation in VoteChain | Residual risk |
|---|---|---|---|---|---|
| S1 | Impersonating a presiding officer to upload figures | Spoofing | attacker submits `submitResult` for a PU | `presidingOfficerOf[puId] == msg.sender`; wallet key never leaves MetaMask; DID credential issued by INEC binds address ↔ role | key theft (out of scope: hardware wallets recommended) |
| S2 | Forged party-agent signature | Spoofing | sign as another party's agent | `isAgentFor` scope check (level + unit + party); one category per address | key theft |
| S3 | Forged auditor approval | Spoofing | submit a signature not from the auditor | `ECDSA.recover` over a domain-separated digest (chain id, contract, state hash) must equal `election.auditor()` | none on-chain |
| S4 | Backend impersonating users | Spoofing | compromised server sends transactions | backend holds no keys and cannot write to the chain; portals sign locally | UI tampering (see T5) |
| T1 | Altering figures in transit / after upload | Tampering | change a stored result | storage is on-chain and append-only; corrections only via `resubmitResult` while Frozen, producing a new round every agent must re-sign | none |
| T2 | Manipulating a collated total | Tampering | ward officer declares inflated totals | `confirmCollation` requires exact equality with Σ approved lower-level results; mismatch is **recorded** (`MismatchAlert`) and the collation stays blocked | none |
| T3 | Skipping a level | Tampering | LGA officer collates unapproved wards | `computeAggregate` reverts `LowerLevelNotApproved` unless every child is Approved | none |
| T4 | Replacing a scanned form | Tampering | swap the EC8A image | CID (content hash) recorded on-chain and bound into `figuresHash`; any change to the file changes the CID | IPFS availability (pinning) |
| T5 | Malicious frontend showing false figures | Tampering | phishing portal | portals recompute `figuresHash` from displayed figures and compare with the chain; agents sign the on-chain hash; anyone can verify from a second client or the public portal | user diligence |
| R1 | Agent denies having signed | Repudiation | "I never approved that" | signature record (agent, hash, timestamp, block, tx) is permanent and public | none |
| R2 | Officer denies an alteration attempt | Repudiation | — | `MismatchAlert` events and `mismatchAttempts` counter are permanent | none |
| R3 | Dispute history erased | Repudiation | — | disputes, resolutions, escalations and rulings are on-chain with timestamps | none |
| I1 | Voter privacy | Information disclosure | link ballots to voters | the system only handles aggregated, already-public polling-unit totals; no ballot data | none |
| I2 | Stakeholder identity exposure | Information disclosure | wallet ↔ person mapping | only wallet addresses on-chain; identity mapping stays in INEC's credential registry (PostgreSQL) | database access control |
| I3 | Session token leakage | Information disclosure | notification inbox | tokens gate only off-chain conveniences; short TTL; signature-based login (no passwords) | HTTPS required in production |
| D1 | Blocking a result forever with disputes | Denial of service | rogue agent disputes repeatedly | one active dispute at a time; officer resolves; escalation ends with an auditor ruling; dismissed ruling waives the agent's slot | delay only |
| D2 | Missing agent stops approval (n-of-n) | Denial of service | agent refuses to sign | intended (Section 2.2.6); objection path lets an agent sign under protest; INEC can revoke/replace agents only before activation | procedural: every unit must have accredited agents before activation |
| D3 | Gas exhaustion in loops | Denial of service | huge wards | aggregation loops are bounded by INEC's geography (≤ ~20 PUs per ward, 33 LGAs); benchmarked at full Oyo scale (`docs/EVALUATION.md`) | mainnet fees |
| D4 | Backend outage | Denial of service | API down | contracts remain fully usable from any client (public verifiability); chain-only mode without PostgreSQL | — |
| E1 | INEC admin declares or alters results | Elevation of privilege | — | admin holds no operational role (`AccessMatrixTest.test_inecAdminHasNoOperationalPowers`); role map frozen after activation; `grantRole` bypass disabled | none |
| E2 | Publisher declares without audit | Elevation of privilege | — | `declareResult` reverts `AuditNotApproved` | none |
| E3 | Module hook abuse | Elevation of privilege | call `openSignatureRound` directly | `onlyModuleFor` — only the registered ResultUpload/CollationEngine addresses; `markDeclared` only from AuditDeclaration | none |
| E4 | Re-entrancy | Elevation of privilege | — | no ETH transfers, no external calls to untrusted contracts; state updated before events; OpenZeppelin AccessControl/ECDSA | none |

Automated evidence: `test/AccessMatrix.t.sol` attempts every write action from every other role;
`test/PartyAgentVerification.t.sol` covers the dispute machine including deadlock handling;
`test/CollationEngine.t.sol` covers T2/T3; `test/AuditDeclaration.t.sol` covers S3/E2.

## 3. Slither static analysis

```bash
pip install slither-analyzer            # needs solc 0.8.28 (solc-select install 0.8.28 && solc-select use 0.8.28)
cd contracts
slither . --filter-paths "lib|node_modules|test|script" --config-file slither.config.json
```

`slither.config.json` excludes the vendored OpenZeppelin/forge-std sources and the informational
naming/versioning detectors. Design decisions relevant to typical detectors:

* **`timestamp`** — `block.timestamp` is only stored for audit records, never used in conditions.
* **`calls-loop`** — `computeAggregate` calls the lower-level module in a loop; the loop is bounded by the
  INEC geography, and results are read-only views (no external state changes inside loops).
* **`reentrancy-benign`** — cross-module calls (`openSignatureRound`, `correctFigures`, `markDeclared`) go to
  addresses fixed at deployment; all state changes precede the calls, and no ETH is transferred.
* **`tx-origin`** — not used (the officer address is passed explicitly to `correctFigures`).
* **`unchecked-lowlevel`** / assembly — none in the contracts (the test suite uses `mstore` only to trim an
  array length).

Record the Slither output (`slither ... --json slither-report.json`) alongside the test results in the
security-evaluation section of Chapter 5.

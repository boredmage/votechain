# VoteChain

**Design and Implementation of a Blockchain-Based Electoral Result Collation and Multi-Party Verification System with Hierarchical Validation from Ward to State Level — a case study of the Oyo State electoral process.**

Olowe Anthony Oluboba (230916) · Department of Computer Science, University of Ibadan · Supervisor: Prof. B.O. Akinkunmi

VoteChain takes over the moment physical voting closes at a polling unit. Presiding officers upload EC8A
figures, the smart contract checks them arithmetically, party agents of every contesting party sign or
dispute them, and results move upward — polling unit → ward → LGA → state — only after the level below
is fully approved and the declared totals equal the sum of the signed lower-level results. The independent
state auditor must sign the state result hash on-chain before the result publisher can declare it. Every
figure, signature, dispute, resolution, mismatch attempt and the declaration is permanent and publicly
verifiable.

## Repository layout

```
votechain/
├── contracts/          Solidity (5 modules) — Foundry project + Hardhat mirror
│   ├── src/            ElectionManager, ResultUpload, PartyAgentVerification, CollationEngine, AuditDeclaration
│   ├── test/           Foundry test suite (85 tests) + Oyo-scale benchmarks
│   ├── test-hardhat/   Mocha + Chai mirror of the suite (npx hardhat test)
│   ├── script/         Foundry deploy + demo seed scripts
│   ├── hardhat/        Hardhat deploy / seed / live-simulation / verify scripts (ethers v6)
│   ├── abi/            Exported ABIs (also copied into backend/ and frontend/)
│   ├── deployments/    <network>.json addresses + demo-accounts.json
│   ├── benchmarks/     Gas / throughput measurements (JSON)
│   └── lib/            Vendored OpenZeppelin v5.7 and forge-std
├── backend/            Node.js + Express: IPFS pipeline, PostgreSQL cache, event indexer, notifications, REST API
├── frontend/           React (Vite) portals for all stakeholder roles + public verification
├── docs/               Architecture, contract API, STRIDE threat model, evaluation tables, demo walkthrough
├── scripts/            export-abis.mjs, benchmark-report.mjs
├── docker-compose.yml  The whole demo in one command (chain, contracts, PostgreSQL, API, UI; optional IPFS)
└── .env.example        Shared configuration
```

## Prerequisites

* Node.js ≥ 18.17 (20 LTS recommended) and npm
* Either **Hardhat** (installed by `npm install` in `contracts/`) or **Foundry** (`curl -L https://foundry.paradigm.xyz | bash && foundryup`) — both are supported; Foundry is fastest for the test-suite and benchmarks
* MetaMask (optional — the demo role switcher works without it)
* Docker (the one-command demo below; otherwise optional, for PostgreSQL / a local IPFS node)

## Quick start (Docker, one command)

```bash
docker compose up -d          # or: npm run docker:up
```

That builds and starts a local chain (anvil, 70 funded accounts), deploys and seeds the demo election,
PostgreSQL, the backend API and the frontend. Open **http://localhost:5173** once `docker compose ps` shows
every service as healthy (about two minutes the first time, for the image builds). Details, reset and
prefill levels: [DEVELOPMENT.md → Docker](DEVELOPMENT.md#0-docker-the-whole-stack-in-one-command).

## Quick start (local demo in five terminals)

```bash
cp .env.example .env                      # defaults target a local node on :8545

# 1. contracts: install, compile, start a local chain
cd contracts && npm install && npx hardhat compile
npx hardhat node                          # terminal 1 — 70 funded demo accounts (test mnemonic)

# 2. deploy + seed the demo election (2 LGAs x 2 wards x 2 PUs, 3 parties, 63 role accounts)
npm run deploy:local                      # terminal 2 — writes deployments/localhost.json
npm run seed:local:prefill                # configures + activates; LGA 2 already collated, LGA 1 left for you
npm run abi                               # (only after changing contracts) refresh ABIs for backend/frontend

# 3. backend
cd ../backend && npm install && npm run dev     # terminal 3 — http://localhost:4000/api

# 4. frontend
cd ../frontend && npm install && npm run dev    # terminal 4 — http://localhost:5173
```

Open http://localhost:5173. With `VITE_DEMO_MODE=true` the top bar offers a **demo role switcher** listing
every stakeholder account (INEC admin, presiding officers, party agents, collation officers, auditor,
publisher). Pick one and the matching portal loads; no MetaMask needed. To use MetaMask instead, import a
key from `contracts/deployments/demo-accounts.json` and connect to `http://127.0.0.1:8545` (chain id 31337).

Using Foundry instead of Hardhat for steps 1–2:

```bash
cd contracts
anvil --accounts 70                                             # terminal 1
forge script script/Deploy.s.sol --rpc-url localhost --broadcast
DEMO_PREFILL=1 forge script script/SeedDemo.s.sol --rpc-url localhost --broadcast
```

### Optional storage services

```bash
docker compose up -d postgres                   # then set DATABASE_URL in .env → event indexer, activity feed, notifications, sessions
docker compose --profile ipfs up -d ipfs        # then IPFS_PROVIDER=kubo → forms pinned to a real IPFS node
```

Without PostgreSQL the backend runs in *chain-only mode*: every read comes straight from the contracts,
uploads use the built-in content-addressed store (`IPFS_PROVIDER=local`, real CIDv1 identifiers), and only
the cached feeds (activity, notifications, sessions, credential registry) report 503.

## Running the tests

```bash
cd contracts
forge test                                  # 85 Foundry tests (unit, integration, access matrix, full flow)
forge test --match-contract BenchmarkTest -vv               # three scalability scenarios → benchmarks/*.json
VOTECHAIN_FULL_SCALE=1 forge test --match-test test_fullOyoState -vv   # 33 LGAs / 363 wards / 4,719 PUs
npx hardhat test                            # Mocha + Chai mirror (ethers v6)
SCALE=medium npm run simulate:local         # wall-clock simulation against the running node → benchmarks/live-*.json
node ../scripts/benchmark-report.mjs        # regenerates docs/EVALUATION.md

cd ../backend && npm test                   # CID + local IPFS provider unit tests
```

## Deploying to Sepolia

```bash
# .env: SEPOLIA_RPC_URL, PRIVATE_KEY (funded deployer = INEC admin), ETHERSCAN_API_KEY
cd contracts
npm run deploy:sepolia                      # writes deployments/sepolia.json
npm run verify:sepolia                      # Etherscan verification
# then register real stakeholder wallets through the INEC Admin portal (Registration phase) and activate.
# backend/frontend: NETWORK=sepolia, RPC_URL / VITE_RPC_URL = your Sepolia RPC, VITE_CHAIN_ID=11155111, DEMO_MODE=false
```

## How the pieces fit

| Layer (Fig. 3.1) | Implementation |
|---|---|
| Blockchain | Ethereum — Hardhat/Anvil locally, Sepolia for the evaluation deployment |
| Smart contracts | `ElectionManager` (roles, geography, lifecycle) · `ResultUpload` (EC8A + six rules) · `PartyAgentVerification` (n-of-n signing, dispute machine) · `CollationEngine` (EC8B/C/D aggregation, mismatch alerts) · `AuditDeclaration` (ecrecover-gated audit, declaration) |
| Application | React portals: INEC admin, presiding officer, party agent (4 levels), ward/LGA collation officers, state returning officer, auditor, publisher, public verifier. All writes are signed by the user's wallet; the backend never holds keys. |
| Storage | IPFS (local store / Kubo / Pinata) for EC8 form scans, evidence, resolutions and the audit report — CIDs on-chain; PostgreSQL display cache fed by the event indexer, plus sessions and notifications |

See `docs/ARCHITECTURE.md` for the data model and state machine, `docs/CONTRACT_API.md` for every
function/event, `docs/SECURITY_STRIDE.md` for the threat model and Slither instructions,
`docs/EVALUATION.md` for the measured gas/throughput figures and `docs/DEMO_WALKTHROUGH.md` for a scripted
defence demonstration.

## Licence

MIT — academic project, University of Ibadan 2025/2026.

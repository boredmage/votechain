# Running VoteChain in development

This guide gets the full stack running locally: a blockchain node, the deployed and seeded contracts, PostgreSQL, the
backend API and the HeroUI frontend. Allow about 10 minutes the first time and 1 minute after that.

```
 Browser ──► Vite dev server :5173 ──/api proxy──► Backend :4000 ──► Local chain :8545
                                                       │
                                                       └──► PostgreSQL :5432 (optional cache)
```

## 0. Docker: the whole stack in one command

If you only want to *run* VoteChain, you need Docker Desktop and nothing else:

```bash
docker compose up -d                 # or: npm run docker:up
docker compose ps                    # wait until backend and frontend are "healthy" (~2 min the first time)
```

Then open **http://localhost:5173** and continue with §4. What starts:

| Service | What it is | Port on your machine |
| --- | --- | --- |
| `chain` | anvil with 70 funded accounts; its state is kept in a volume across restarts | 8545 |
| `postgres` | the display cache | 5432 |
| `deployer` | one-shot job: deploys the contracts and seeds the demo election, then exits | – |
| `backend` | the API | 4000 |
| `frontend` | the production build, served by nginx, which proxies `/api` to the backend | 5173 |
| `ipfs` | optional Kubo node (`IPFS_PROVIDER=kubo docker compose --profile ipfs up -d`) | 5001 / 8080 |

The containers reach each other by service name; only the ports above are published. The browser signs
demo transactions against `http://127.0.0.1:8545`, and MetaMask uses that same RPC URL (chain ID 31337).
The demo keys are the usual test-mnemonic accounts, so `contracts/deployments/demo-accounts.json` in the
repository stays valid. The compose file does **not** read the repository `.env` (its URLs point at
127.0.0.1 for the terminal workflow below); the only knobs it takes from the environment are `DEMO_PREFILL`,
`IPFS_PROVIDER` and `FRONTEND_PORT`.

```bash
DEMO_PREFILL=all docker compose up -d      # seed level on first start: none | lga (default) | all | declared
npm run docker:logs                        # follow the deployer, backend and frontend logs
npm run docker:down                        # stop; chain state, database and uploads survive
npm run docker:reset                       # fresh election: wipes chain, database and uploads, then starts again
docker compose up -d --build backend       # after editing backend/src (same for frontend)
```

`docker compose up` is idempotent: the deployer sees the contracts already on the chain and skips. To
re-seed at a different level, run `npm run docker:reset` (`DEMO_PREFILL=<level> npm run docker:reset`). If
you have been using the terminal workflow, stop anvil, the backend and Vite first: they use the same ports.

## 1. Prerequisites

| Tool | Version | Needed for |
| --- | --- | --- |
| Node.js + npm | **20.19 or newer** (22 LTS recommended) | Everything. Vite 7 refuses older Node. |
| Foundry (`anvil`, `forge`) | latest — `curl -L https://foundry.paradigm.xyz \| bash && foundryup` | Recommended local chain and the fast test suite |
| Docker Desktop | any recent | The one-command stack (§0), or just PostgreSQL (activity feed, notifications, stakeholder list, sign-in). Optional. |

Hardhat is installed by `npm install` in `contracts/`, so Foundry is optional if you prefer `npx hardhat node`.
Hardhat prints an "unsupported Node.js version" warning on Node 23+. It is harmless for local development.

## 2. One-time setup

From the repository root (`votechain/`):

```bash
cp .env.example .env          # defaults already target localhost:8545 / :4000 / :5173
npm run install:all           # installs contracts/, backend/ and frontend/
npx --prefix frontend playwright install chromium   # only if you will run the e2e walkthrough
```

Running without Docker? Open `.env` and empty the database line: `DATABASE_URL=`. The backend then runs in
*chain-only mode*. Every result is still read from the contracts, but the activity feed, notifications, sign-in and
stakeholder list show a "needs PostgreSQL" message.

## 3. Start everything (four terminals)

Run each block in its own terminal, from the repository root, in this order.

**Terminal 1: local blockchain**

```bash
anvil --accounts 70            # or: npm run chain   (Hardhat node, also 70 accounts)
```

Leave it running. It must have 70 funded accounts, because the seed script registers 63 stakeholder wallets.

**Terminal 2: database, contracts and demo election**

```bash
docker compose up -d postgres          # skip if DATABASE_URL is empty
npm run deploy:local                   # deploys the 5 contracts → contracts/deployments/localhost.json
npm run seed:local                     # demo election (2 LGAs × 2 wards × 2 PUs, 3 parties), LGA 2 pre-collated
```

`npm run seed:local` uses the `lga` prefill level: LGA 2 is already collated, and LGA 1 is left for you to drive
through the portals. To start at a different point (empty, fully collated, or declared), use `npm run reset` (§5).

**Terminal 3: backend API** (http://localhost:4000/api)

```bash
npm run backend                # node --watch: restarts when backend/src changes
```

On startup it should print `database schema ready` (or `chain-only mode`) and `API listening on
http://localhost:4000/api`. You don't need a separate migration step; the schema is applied on every start.

**Terminal 4: frontend** (http://localhost:5173)

```bash
npm run frontend               # Vite with hot reload; /api is proxied to :4000
```

## 4. Use it

Open **http://localhost:5173**.

- **Public verification:** works with no wallet. Pick any unit in the collation tree.
- **Act as a stakeholder:** click the **"Act as a demo role…"** box in the header and type to filter, e.g.
  `Presiding`, `PA Agent`, `Ward`, or an account number such as `#4`. The matching portal opens with no MetaMask
  needed.

Useful demo accounts:

| # | Role | Try |
| --- | --- | --- |
| 0 | INEC Admin | Lifecycle, geography, stakeholders, credentials |
| 4 | Presiding Officer, PU OY/11/01/001 | Upload EC8A. Registered voters must be **812** (the INEC register) |
| 18, 33, 48 | PA, DC and LF agents for that PU | Sign, sign with objection, raise a dispute |
| 1 | State Returning Officer | EC8D state collation |
| 2 | Independent Auditor | Rulings on escalations, the audit signature |
| 3 | Result Publisher | Declare the final result |

The full list, with private keys, is in `contracts/deployments/demo-accounts.json`.

**Using MetaMask instead:** add the network RPC `http://127.0.0.1:8545`, chain ID `31337`. Import a private key from
`demo-accounts.json`, then click **Connect wallet**.

Click **Sign in** in the header (one free signature, no transaction) to enable the notifications panel.

## 5. Day-to-day workflow

| You changed… | Do this |
| --- | --- |
| `frontend/src/**` | Nothing. Vite hot-reloads. |
| `backend/src/**` | Nothing. `node --watch` restarts the backend. |
| `contracts/src/**` | `npm --prefix contracts run compile`, then `npm run abi` (copies ABIs to backend/ and frontend/), then `npm run reset` (below) |
| `.env` | Restart the backend and the Vite server |

### Reset and prefill: one command

With the chain and backend running, reset everything and choose how far the demo election is already driven:

```bash
npm run reset                 # = lga (default)
npm run reset -- none         # election configured and activated; nothing uploaded yet
npm run reset -- lga          # LGA 2 (Akinyele) fully collated; LGA 1 left for you — the e2e walkthrough expects this
npm run reset -- all          # every PU, ward, LGA and the state approved (phase Collation); auditor and publisher next
npm run reset -- declared     # the finished election: audit signed and result declared
```

It takes about 8 seconds and does the following, in order:

1. Wipes the chain **in place** (`anvil_reset` / `hardhat_reset`). You don't need to restart anvil.
2. Drops and recreates the PostgreSQL schema, if `DATABASE_URL` is set.
3. Redeploys the contracts (same addresses every time) and runs the seed at the chosen level.
4. Restarts the backend by touching `backend/src/server.js`. That works when it runs under `npm run backend`
   (`node --watch`); if you started it another way, restart it yourself.

Then refresh the browser. What each level leaves you to do:

| Level | Phase after reset | Start the demo as… |
| --- | --- | --- |
| `none` | Active | Presiding Officer **#4** uploads the first EC8A (registered voters = 812) |
| `lga` | Active | Presiding Officer **#4**, then agents **#18, #33, #48**, then Ward officer **#12**, LGA officer **#16**, state officer **#1** |
| `all` | Collation | Independent Auditor **#2** signs the audit, then Result Publisher **#3** declares |
| `declared` | Declared | Anyone: open **Public verification** to explore the complete trail |

The same levels work when seeding directly: `DEMO_PREFILL=all npm --prefix contracts run seed:local`. Prefilled units
point at a placeholder form CID, so their "Scanned form" panel says the scan is not retrievable. Units you upload
through the UI show the real image.

<details>
<summary>Manual reset (if the script can't reach your chain or database)</summary>

```bash
# stop anvil (Ctrl+C in terminal 1), then start it again: anvil --accounts 70
docker compose down -v                 # removes the postgres container AND its data volume
docker compose up -d postgres
npm run deploy:local
DEMO_PREFILL=lga npm --prefix contracts run seed:local     # or none / all / declared
# restart the backend (Ctrl+C, then npm run backend); refresh the browser
```

</details>

## 6. Tests

```bash
cd contracts && forge test                    # 131 tests: unit, integration, access matrix, stress (fuzz, invariants, PoCs, gas)
cd contracts && forge test --match-path "test/stress/*" -vv     # just the stress suite
cd contracts && npx hardhat test              # 40 Mocha/Chai tests
npm run test:backend                          # backend unit tests

# End-to-end walkthrough of every portal (needs a fresh `lga` election: run `npm run reset` first)
cd frontend && BASE_URL=http://localhost:5173 node e2e/walkthrough.mjs     # screenshots → frontend/e2e/screenshots/
```

The walkthrough is not idempotent: it uploads, disputes and declares. Run `npm run reset` before each run.

## 7. Ports and configuration

| Service | Port | Configured by (`.env`) |
| --- | --- | --- |
| Chain (anvil / Hardhat) | 8545 | `RPC_URL`, `VITE_RPC_URL` |
| Backend API | 4000 | `PORT`, `VITE_API_URL` |
| Frontend (Vite) | 5173 | `frontend/vite.config.js` |
| PostgreSQL | 5432 | `DATABASE_URL` |
| IPFS (Kubo, optional) | 5001 / 8080 | `IPFS_PROVIDER=kubo`, then `docker compose --profile ipfs up -d ipfs` |

By default uploads use `IPFS_PROVIDER=local`, a content-addressed store on disk with real CIDv1 identifiers. You
don't need an IPFS node.

## 8. Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Cannot reach the VoteChain backend" | The backend isn't running, or it can't find `contracts/deployments/localhost.json`. Run the deploy first. |
| Yellow banner "Connection to the VoteChain backend lost" | The backend stopped or restarted. It clears by itself once the backend is back. |
| Activity feed shows old or impossible events | The chain was restarted but the database wasn't. Run `npm run reset`. |
| Seed fails with "insufficient funds" or a missing account | The chain was started with fewer than 70 accounts. Use `anvil --accounts 70`. |
| `EADDRINUSE` on 8545 / 4000 / 5173 / 5432 | Something else is on that port (often the Docker stack from §0, or the other way round): `lsof -iTCP:<port> -sTCP:LISTEN`. Stop it, or change the port in `.env`. |
| Docker: `deployer` exits with an error | `npm run docker:logs`. Usually the chain volume and the deployments volume are out of step; `npm run docker:reset` fixes it. |
| Vite exits with a Node version error | Upgrade Node to 20.19 or newer. |
| "Pinned (local)" never appears after choosing a file | The backend is down or the file is over `MAX_UPLOAD_BYTES` (15 MB). |
| EC8A submit stays disabled | The hint next to the button says what's missing: an empty field, a failing rule (often registered voters ≠ the INEC register), or no form photo. |
| MetaMask "nonce too high" after a reset | MetaMask → Settings → Advanced → **Clear activity tab data**. |

## 9. Stopping

```bash
# Ctrl+C in each terminal (anvil, backend, frontend), then:
docker compose stop postgres           # keeps data;  `docker compose down -v` deletes it
# Docker stack (§0):  npm run docker:down   (keeps data)   or   docker compose down -v   (deletes it)
```

> **Never use the demo setup on a public network.** `DEMO_MODE=true` makes `/api/demo-accounts` serve every demo
> private key. For a Sepolia deployment, set `DEMO_MODE=false` and `VITE_DEMO_MODE=false` (see README → Deploying
> to Sepolia).

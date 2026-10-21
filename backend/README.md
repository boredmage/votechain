# VoteChain backend

Node ≥ 18 · Express · ethers v6 · pg · multer. `npm install && npm run dev` (http://localhost:4000/api).

Reads the deployed contracts from `../contracts/deployments/<NETWORK>.json` and the ABIs from `abi/`. Set
`DATABASE_URL` to enable the event indexer, activity feed, notifications, sessions and credential registry
(`docker compose up -d postgres`); without it the API runs in chain-only mode. `IPFS_PROVIDER=local|kubo|pinata`
selects where scanned forms are pinned. `npm test` runs the CID / local-store unit tests.

| Route | Purpose |
|---|---|
| `GET /api/health`, `GET /api/config` | liveness, chain/contract configuration |
| `GET /api/election`, `GET /api/election/geography` | summary, LGA→ward→PU tree with statuses |
| `GET /api/units/:level/:id` | full unit detail (figures, form CID, signatures, disputes, aggregate) |
| `POST /api/units/pu/:id/validate`, `POST /api/units/:level/:id/check-collation` | pre-checks mirroring the contracts |
| `GET /api/disputes[?status=]`, `/api/disputes/escalated`, `/api/disputes/:id` | dispute records |
| `GET /api/audit`, `GET /api/chain`, `GET /api/verify/:level/:id` | audit/declaration, full trace, consistency recomputation |
| `GET /api/stakeholders/:address`, `GET /api/stakeholders` | role lookup (chain), listing (cache) |
| `POST /api/ipfs/upload`, `GET /api/ipfs/:cid`, `GET /api/ipfs/:cid/exists` | IPFS pipeline |
| `POST /api/auth/nonce`, `/verify`, `GET /api/auth/me`, `POST /api/auth/logout` | wallet sign-in sessions |
| `GET /api/notifications`, `POST /api/notifications/:id/read`, `/read-all` | per-role inbox (session) |
| `GET /api/activity`, `/api/alerts`, `/api/summary`, `/api/indexer` | cached feeds |
| `GET /api/credentials/message/:address`, `POST /api/credentials/issue`, `/verify`, `GET /api/credentials/:address` | DID-style credentials |
| `GET /api/demo-accounts` | demo role accounts (DEMO_MODE only) |

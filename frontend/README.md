# VoteChain frontend

React 19 + Vite 7 + **HeroUI v3** (Tailwind CSS v4, React Aria) + ethers v6. `npm install && npm run dev`
(http://localhost:5173). Configuration comes from the repository-root `.env` (`VITE_API_URL`, `VITE_RPC_URL`,
`VITE_CHAIN_ID`, `VITE_DEMO_MODE`); a static deployment can also define `window.__VOTECHAIN_ENV__` before the
bundle loads (see `src/lib/env.js`).

* `src/hooks/useApp.jsx` — wallet (MetaMask or demo key), on-chain role, election polling, `sendTx` with custom-error decoding, HeroUI toasts
* `src/portals/*` — one portal per stakeholder category + the public verifier (`src/App.jsx` maps role → portal; officer portals are lazy-loaded)
* `src/components/common.jsx` — the design-system layer: `Panel`, `StatusBadge`, `Alert`, `FiguresTable`, `FiguresForm`, `IpfsUpload`, `ConfirmButton`, `Checklist`… built on HeroUI. Portals use these rather than styling HeroUI directly, so status colours stay consistent
* `src/components/layout.jsx` — header (searchable demo role switcher, light/dark toggle), phase stepper, notifications, activity feed
* `src/styles.css` — Tailwind + `@heroui/styles` imports and the brand tokens (green accent, WCAG-AA muted text) for light and dark themes
* `src/lib/figures.js` — client-side mirror of the six validation rules and the on-chain `figuresHash`
* `src/abi/*.json` — exported contract ABIs (`node ../scripts/export-abis.mjs` after recompiling)

## Design conventions

* Irreversible on-chain actions (activate, close uploads, cancel a polling unit, revoke, raise/escalate/rule on a dispute, declare) go through `ConfirmButton` (HeroUI AlertDialog).
* IDs are never typed by hand: LGA, ward, polling-unit and party fields are HeroUI `Select` pickers populated from the read model.
* Stable test hooks are `data-testid` attributes (`role-switcher-input`, `role-option-<n>`, `figures-form`, `disconnect`, `confirm-action`, `tree-pu-<id>`…) and `data-status` on status chips.

## End-to-end walkthrough

```bash
# local node + deploy + `npm run seed:local:prefill` (contracts), backend and frontend running
npx playwright install chromium
BASE_URL=http://localhost:5173 node e2e/walkthrough.mjs   # 19 steps, screenshots → e2e/screenshots/
```

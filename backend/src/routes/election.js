import { Router } from "express";
import {
  readElectionSummary,
  readGeography,
  readUnit,
  readDispute,
  readStakeholder,
  readAuditAndDeclaration,
  readChainTrace,
  getChain,
  levelIndex,
  LEVELS,
  num,
} from "../chain.js";
import { hasDb, query } from "../db.js";
import { loadDemoAccounts, config } from "../config.js";

export const electionRouter = Router();

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

electionRouter.get(
  "/election",
  wrap(async (_req, res) => {
    res.json(await readElectionSummary());
  }),
);

electionRouter.get(
  "/election/geography",
  wrap(async (_req, res) => {
    res.json(await readGeography());
  }),
);

electionRouter.get(
  "/units/:level/:id",
  wrap(async (req, res) => {
    res.json(await readUnit(req.params.level, req.params.id));
  }),
);

/** Pre-validates polling-unit figures exactly as ResultUpload.validateFigures would. */
electionRouter.post(
  "/units/pu/:id/validate",
  wrap(async (req, res) => {
    const { contracts } = getChain();
    const f = req.body?.figures;
    if (!f) return res.status(400).json({ error: "figures required" });
    const [rule, expected, actual] = await contracts.upload.validateFigures(Number(req.params.id), {
      registeredVoters: BigInt(f.registeredVoters ?? 0),
      accreditedVoters: BigInt(f.accreditedVoters ?? 0),
      totalVotesCast: BigInt(f.totalVotesCast ?? 0),
      validVotes: BigInt(f.validVotes ?? 0),
      rejectedVotes: BigInt(f.rejectedVotes ?? 0),
      candidateVotes: (f.candidateVotes ?? []).map((v) => BigInt(v ?? 0)),
    });
    const { RULES } = await import("../chain.js");
    res.json({ ok: num(rule) === 0, rule: RULES[num(rule)], expected: num(expected), actual: num(actual) });
  }),
);

/** Checks declared collation totals against the computed aggregate (CollationEngine.checkDeclared). */
electionRouter.post(
  "/units/:level/:id/check-collation",
  wrap(async (req, res) => {
    const { contracts } = getChain();
    const lvl = levelIndex(req.params.level);
    const f = req.body?.figures;
    if (!f) return res.status(400).json({ error: "figures required" });
    const [ok, field, candidateIndex, declared, computed] = await contracts.collation.checkDeclared(lvl, Number(req.params.id), {
      registeredVoters: BigInt(f.registeredVoters ?? 0),
      accreditedVoters: BigInt(f.accreditedVoters ?? 0),
      totalVotesCast: BigInt(f.totalVotesCast ?? 0),
      validVotes: BigInt(f.validVotes ?? 0),
      rejectedVotes: BigInt(f.rejectedVotes ?? 0),
      candidateVotes: (f.candidateVotes ?? []).map((v) => BigInt(v ?? 0)),
    });
    const { FIELDS } = await import("../chain.js");
    res.json({ ok, field: FIELDS[num(field)], candidateIndex: num(candidateIndex), declared: num(declared), computed: num(computed) });
  }),
);

electionRouter.get(
  "/disputes",
  wrap(async (req, res) => {
    const { contracts } = getChain();
    const count = num(await contracts.verification.disputeCount());
    const list = [];
    for (let i = count; i >= 1; i--) list.push(await readDispute(i));
    const status = req.query.status;
    res.json(status ? list.filter((d) => d.status === status) : list);
  }),
);

electionRouter.get(
  "/disputes/escalated",
  wrap(async (_req, res) => {
    const { contracts } = getChain();
    const ids = Array.from(await contracts.verification.escalatedDisputeIds()).map(num);
    res.json(await Promise.all(ids.map(readDispute)));
  }),
);

electionRouter.get(
  "/disputes/:id",
  wrap(async (req, res) => {
    res.json(await readDispute(Number(req.params.id)));
  }),
);

electionRouter.get(
  "/audit",
  wrap(async (_req, res) => {
    res.json(await readAuditAndDeclaration());
  }),
);

electionRouter.get(
  "/chain",
  wrap(async (_req, res) => {
    res.json(await readChainTrace());
  }),
);

electionRouter.get(
  "/verify/:level/:id",
  wrap(async (req, res) => {
    const { contracts } = getChain();
    const lvl = levelIndex(req.params.level);
    const id = Number(req.params.id);
    if (lvl === 0) {
      const unit = await readUnit(0, id);
      return res.json({ level: LEVELS[lvl], unitId: id, status: unit.status, figuresHash: unit.figuresHash, signatures: unit.signatures, note: "Polling-unit figures are validated at submission; consistency is enforced upward from here." });
    }
    const [consistent, field, candidateIndex, stored, computed] = await contracts.collation.verifyConsistency(lvl, id);
    const { FIELDS } = await import("../chain.js");
    res.json({ level: LEVELS[lvl], unitId: id, consistent, field: FIELDS[num(field)], candidateIndex: num(candidateIndex), stored: num(stored), computed: num(computed) });
  }),
);

electionRouter.get(
  "/stakeholders/:address",
  wrap(async (req, res) => {
    res.json(await readStakeholder(req.params.address));
  }),
);

electionRouter.get(
  "/stakeholders",
  wrap(async (req, res) => {
    if (!hasDb()) return res.status(503).json({ error: "stakeholder listing needs the PostgreSQL cache (DATABASE_URL)" });
    const { level, unitId, category } = req.query;
    const clauses = ["NOT revoked"];
    const params = [];
    if (level !== undefined) {
      params.push(levelIndex(level));
      clauses.push(`level = $${params.length}`);
    }
    if (unitId !== undefined) {
      params.push(Number(unitId));
      clauses.push(`unit_id = $${params.length}`);
    }
    if (category) {
      params.push(category);
      clauses.push(`category = $${params.length}`);
    }
    // a state-scale election registers tens of thousands of wallets: `limit` keeps a listing page-sized
    const limit = Math.min(Math.max(Number(req.query.limit) || 0, 0), 5000);
    const r = await query(`SELECT address, category, level, unit_id AS "unitId", party_id AS "partyId" FROM stakeholders WHERE ${clauses.join(" AND ")} ORDER BY category, level, unit_id, party_id${limit ? ` LIMIT ${limit}` : ""}`, params);
    res.json(r.rows);
  }),
);

/** Order of the demo role switcher (mirrors the collation flow). */
const DEMO_ROLE_ORDER = ["InecAdmin", "PresidingOfficer", "PartyAgent", "WardCollationOfficer", "LgaCollationOfficer", "StateReturningOfficer", "Auditor", "ResultPublisher"];
let demoOrdered = null; // { demo, list } — accounts in switcher order, with their lower-cased search text

function orderedDemoAccounts(demo) {
  if (demoOrdered?.demo !== demo) {
    const rank = (a) => (DEMO_ROLE_ORDER.indexOf(a.category) + DEMO_ROLE_ORDER.length + 1) % (DEMO_ROLE_ORDER.length + 1);
    const list = demo.accounts.map((account) => ({ account, text: `${account.role} #${account.index}`.toLowerCase() }));
    list.sort((a, b) => rank(a.account) - rank(b.account) || a.account.index - b.account.index);
    demoOrdered = { demo, list };
  }
  return demoOrdered.list;
}

/** The demo accounts matching what was typed: "#12" finds an account number, anything else its role text. */
function searchDemoAccounts(list, text) {
  const q = String(text ?? "").trim().toLowerCase();
  if (!q) return list;
  if (/^#\d+$/.test(q)) {
    const number = q.slice(1);
    const hits = list.filter(({ account }) => String(account.index).startsWith(number));
    const exact = (h) => (String(h.account.index) === number ? 0 : 1);
    return hits.sort((a, b) => exact(a) - exact(b) || a.account.index - b.account.index);
  }
  const words = q.split(/\s+/);
  return list.filter(({ text: hay }) => words.every((w) => hay.includes(w)));
}

/**
 * Demo helper: known accounts for every role (only when DEMO_MODE=true and the seed script ran).
 * A state-scale election has tens of thousands of them, so this returns the best `limit` matches for
 * `q` (a role, a place, a unit code or "#number") together with how many matched and how many exist.
 */
electionRouter.get("/demo-accounts", (req, res) => {
  const demo = loadDemoAccounts();
  if (!demo) return res.status(404).json({ error: "demo accounts not available (DEMO_MODE=false or seed script not run)" });
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const found = searchDemoAccounts(orderedDemoAccounts(demo), req.query.q);
  res.json({ chainId: demo.chainId, warning: demo.warning, total: demo.accounts.length, matches: found.length, accounts: found.slice(0, limit).map((f) => f.account) });
});

electionRouter.get("/config", (_req, res) => {
  const { deployment } = getChain();
  res.json({ network: config.network, rpcUrl: config.rpcUrl, chainId: deployment.chainId, contracts: deployment.contracts, ipfsProvider: config.ipfs.provider, demoMode: config.demoMode, database: hasDb() });
});

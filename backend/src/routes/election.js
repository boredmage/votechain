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
    const r = await query(`SELECT address, category, level, unit_id AS "unitId", party_id AS "partyId" FROM stakeholders WHERE ${clauses.join(" AND ")} ORDER BY category, level, unit_id, party_id`, params);
    res.json(r.rows);
  }),
);

/** Demo helper: known accounts for every role (only when DEMO_MODE=true and the seed script ran). */
electionRouter.get("/demo-accounts", (_req, res) => {
  const demo = loadDemoAccounts();
  if (!demo) return res.status(404).json({ error: "demo accounts not available (DEMO_MODE=false or seed script not run)" });
  res.json(demo);
});

electionRouter.get("/config", (_req, res) => {
  const { deployment } = getChain();
  res.json({ network: config.network, rpcUrl: config.rpcUrl, chainId: deployment.chainId, contracts: deployment.contracts, ipfsProvider: config.ipfs.provider, demoMode: config.demoMode, database: hasDb() });
});

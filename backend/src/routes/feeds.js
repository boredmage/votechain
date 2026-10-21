/**
 * Cached feeds served from PostgreSQL: activity log, mismatch alerts, cached results, per-wallet
 * notifications and the DID-style stakeholder credentials.
 */
import { Router } from "express";
import { ethers } from "ethers";
import { query, requireDb } from "../db.js";
import { requireSession } from "./auth.js";
import { readStakeholder, levelIndex, getChain, CATEGORIES } from "../chain.js";
import { indexer } from "../indexer.js";

export const feedsRouter = Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

feedsRouter.get("/indexer", (_req, res) => res.json(indexer.status()));

feedsRouter.get(
  "/activity",
  requireDb,
  wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 500);
    const clauses = [];
    const params = [];
    if (req.query.level !== undefined) {
      params.push(levelIndex(req.query.level));
      clauses.push(`level = $${params.length}`);
    }
    if (req.query.unitId !== undefined) {
      params.push(Number(req.query.unitId));
      clauses.push(`unit_id = $${params.length}`);
    }
    if (req.query.name) {
      params.push(String(req.query.name));
      clauses.push(`name = $${params.length}`);
    }
    params.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const r = await query(
      `SELECT id, block_number AS "blockNumber", block_time AS "blockTime", tx_hash AS "txHash", contract, name, level, unit_id AS "unitId", actor, args
       FROM chain_events ${where} ORDER BY block_number DESC, log_index DESC LIMIT $${params.length}`,
      params,
    );
    res.json(r.rows);
  }),
);

feedsRouter.get(
  "/alerts",
  requireDb,
  wrap(async (_req, res) => {
    const r = await query(
      `SELECT id, level, unit_id AS "unitId", officer, field, candidate_index AS "candidateIndex", declared, computed, attempt, block_number AS "blockNumber", block_time AS "blockTime", tx_hash AS "txHash"
       FROM mismatch_alerts ORDER BY id DESC LIMIT 200`,
    );
    res.json(r.rows);
  }),
);

feedsRouter.get(
  "/summary",
  requireDb,
  wrap(async (_req, res) => {
    const statuses = await query("SELECT level, status, count(*)::int AS count FROM unit_status GROUP BY level, status ORDER BY level, status");
    const disputes = await query("SELECT status, count(*)::int AS count FROM disputes GROUP BY status");
    const alerts = await query("SELECT count(*)::int AS count FROM mismatch_alerts");
    const events = await query("SELECT count(*)::int AS count FROM chain_events");
    res.json({ unitStatuses: statuses.rows, disputes: disputes.rows, mismatchAlerts: alerts.rows[0].count, events: events.rows[0].count, indexer: indexer.status() });
  }),
);

feedsRouter.get(
  "/notifications",
  requireDb,
  requireSession,
  wrap(async (req, res) => {
    const unreadOnly = req.query.unread === "true";
    const r = await query(
      `SELECT id, kind, level, unit_id AS "unitId", message, payload, tx_hash AS "txHash", created_at AS "createdAt", read
       FROM notifications WHERE recipient = $1 ${unreadOnly ? "AND NOT read" : ""} ORDER BY created_at DESC, id DESC LIMIT 200`,
      [req.session.address],
    );
    res.json(r.rows);
  }),
);

feedsRouter.post(
  "/notifications/:id/read",
  requireDb,
  requireSession,
  wrap(async (req, res) => {
    await query("UPDATE notifications SET read = true WHERE id = $1 AND recipient = $2", [Number(req.params.id), req.session.address]);
    res.json({ ok: true });
  }),
);

feedsRouter.post(
  "/notifications/read-all",
  requireDb,
  requireSession,
  wrap(async (req, res) => {
    await query("UPDATE notifications SET read = true WHERE recipient = $1", [req.session.address]);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// DID-style stakeholder credentials (Section 2.2.4): INEC issues a signed credential binding a
// wallet DID (did:ethr:<chainId>:<address>) to its role and scope; anyone can verify it against
// the issuer signature *and* the on-chain role registry.
// ---------------------------------------------------------------------------
export function credentialMessage(payload) {
  return `VoteChain Stakeholder Credential\n${JSON.stringify(payload)}`;
}

feedsRouter.post(
  "/credentials/issue",
  requireDb,
  wrap(async (req, res) => {
    const { address, signature, payload: signed } = req.body ?? {};
    if (!address || !signature || !signed) return res.status(400).json({ error: "address, payload and issuer signature required" });
    const subject = ethers.getAddress(address);
    const onchain = await readStakeholder(subject);
    if (onchain.category === "None") return res.status(404).json({ error: "address is not a registered stakeholder" });
    const { deployment } = getChain();
    // The admin signs the exact payload served by /credentials/message; it is accepted only if every
    // role field still matches the chain and it was minted recently (no back-dated credentials).
    const expected = {
      did: `did:ethr:${deployment.chainId}:${subject}`,
      category: onchain.category,
      level: onchain.levelIndex,
      unitId: onchain.unitId,
      partyId: onchain.partyId,
      election: deployment.contracts.ElectionManager,
    };
    for (const [k, v] of Object.entries(expected)) {
      if (String(signed[k]) !== String(v)) return res.status(409).json({ error: `credential field "${k}" does not match the on-chain role` });
    }
    const issuedMs = Date.parse(signed.issuedAt);
    if (!Number.isFinite(issuedMs) || Date.now() - issuedMs > 10 * 60_000 || issuedMs - Date.now() > 60_000)
      return res.status(400).json({ error: "credential issuedAt must be within the last 10 minutes" });
    const payload = { ...expected, issuedAt: signed.issuedAt, expiresAt: signed.expiresAt ?? null };
    let issuer;
    try {
      issuer = ethers.verifyMessage(credentialMessage(payload), signature);
    } catch {
      return res.status(400).json({ error: "malformed issuer signature" });
    }
    const issuerRole = await readStakeholder(issuer);
    if (issuerRole.category !== "InecAdmin") return res.status(403).json({ error: "credentials can only be issued by an INEC admin wallet" });
    const r = await query(
      `INSERT INTO credentials (did, address, category, level, unit_id, party_id, issuer, issued_at, expires_at, signature, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [payload.did, subject.toLowerCase(), payload.category, payload.level, payload.unitId, payload.partyId, issuer.toLowerCase(), payload.issuedAt, payload.expiresAt, signature, JSON.stringify(payload)],
    );
    res.status(201).json({ id: r.rows[0].id, payload, issuer, signature });
  }),
);

/** Returns the message an INEC admin must sign to issue a credential for `address`. */
feedsRouter.get(
  "/credentials/message/:address",
  wrap(async (req, res) => {
    const subject = ethers.getAddress(req.params.address);
    const onchain = await readStakeholder(subject);
    if (onchain.category === "None") return res.status(404).json({ error: "address is not a registered stakeholder" });
    const { deployment } = getChain();
    const payload = {
      did: `did:ethr:${deployment.chainId}:${subject}`,
      category: onchain.category,
      level: onchain.levelIndex,
      unitId: onchain.unitId,
      partyId: onchain.partyId,
      election: deployment.contracts.ElectionManager,
      issuedAt: new Date().toISOString(),
      expiresAt: req.query.expiresAt ?? null,
    };
    res.json({ payload, message: credentialMessage(payload) });
  }),
);

feedsRouter.post(
  "/credentials/verify",
  wrap(async (req, res) => {
    const { payload, signature } = req.body ?? {};
    if (!payload || !signature) return res.status(400).json({ error: "payload and signature required" });
    let issuer;
    try {
      issuer = ethers.verifyMessage(credentialMessage(payload), signature);
    } catch {
      return res.status(400).json({ error: "malformed signature" });
    }
    const issuerRole = await readStakeholder(issuer);
    const subject = String(payload.did ?? "").split(":").pop();
    const onchain = subject ? await readStakeholder(subject) : null;
    const matchesChain = onchain && onchain.category === payload.category && onchain.levelIndex === payload.level && onchain.unitId === payload.unitId && onchain.partyId === payload.partyId;
    const expired = payload.expiresAt ? new Date(payload.expiresAt) < new Date() : false;
    res.json({ valid: issuerRole.category === "InecAdmin" && Boolean(matchesChain) && !expired, issuer, issuerIsInecAdmin: issuerRole.category === "InecAdmin", matchesOnChainRole: Boolean(matchesChain), expired, onchain });
  }),
);

feedsRouter.get(
  "/credentials/:address",
  requireDb,
  wrap(async (req, res) => {
    const r = await query(`SELECT id, did, category, level, unit_id AS "unitId", party_id AS "partyId", issuer, issued_at AS "issuedAt", expires_at AS "expiresAt", signature, payload FROM credentials WHERE address = $1 AND NOT revoked ORDER BY id DESC`, [ethers.getAddress(req.params.address).toLowerCase()]);
    res.json(r.rows);
  }),
);

export { CATEGORIES };

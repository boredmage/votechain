/**
 * Wallet-based sessions (sign-in with Ethereum, simplified). The signature proves control of the
 * stakeholder wallet; the resulting session token only gates *off-chain conveniences* such as the
 * notification inbox — every on-chain action is still authorised by the smart contracts themselves.
 */
import { randomBytes } from "node:crypto";
import { Router } from "express";
import { ethers } from "ethers";
import { query, requireDb } from "../db.js";
import { config } from "../config.js";
import { readStakeholder } from "../chain.js";

export const authRouter = Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

export function loginMessage(address, nonce, chainId) {
  return [
    "VoteChain sign-in",
    "",
    `Wallet: ${address}`,
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    "",
    "This signature only authenticates you to the VoteChain portal. It does not send a transaction.",
  ].join("\n");
}

authRouter.post(
  "/nonce",
  requireDb,
  wrap(async (req, res) => {
    const address = ethers.getAddress(String(req.body?.address ?? ""));
    const nonce = randomBytes(16).toString("hex");
    await query("INSERT INTO auth_nonces (address, nonce, created_at) VALUES ($1,$2,now()) ON CONFLICT (address) DO UPDATE SET nonce = EXCLUDED.nonce, created_at = now()", [address.toLowerCase(), nonce]);
    const { chainId } = (await import("../chain.js")).getChain().deployment;
    res.json({ address, nonce, message: loginMessage(address, nonce, chainId) });
  }),
);

authRouter.post(
  "/verify",
  requireDb,
  wrap(async (req, res) => {
    const address = ethers.getAddress(String(req.body?.address ?? ""));
    const signature = String(req.body?.signature ?? "");
    const r = await query("SELECT nonce, created_at FROM auth_nonces WHERE address = $1", [address.toLowerCase()]);
    if (!r.rowCount) return res.status(400).json({ error: "request a nonce first" });
    if (Date.now() - new Date(r.rows[0].created_at).getTime() > 10 * 60 * 1000) return res.status(400).json({ error: "nonce expired" });
    const { chainId } = (await import("../chain.js")).getChain().deployment;
    const message = loginMessage(address, r.rows[0].nonce, chainId);
    let recovered;
    try {
      recovered = ethers.verifyMessage(message, signature);
    } catch {
      return res.status(400).json({ error: "malformed signature" });
    }
    if (recovered.toLowerCase() !== address.toLowerCase()) return res.status(401).json({ error: "signature does not match the address" });
    // consume the nonce atomically BEFORE minting a session: of N concurrent replays of one
    // signature, exactly one DELETE matches the row, the rest are refused
    const consumed = await query("DELETE FROM auth_nonces WHERE address = $1 AND nonce = $2", [address.toLowerCase(), r.rows[0].nonce]);
    if (!consumed.rowCount) return res.status(401).json({ error: "nonce already used — request a new one" });
    const token = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + config.sessionTtlSeconds * 1000);
    await query("INSERT INTO sessions (token, address, expires_at) VALUES ($1,$2,$3)", [token, address.toLowerCase(), expires]);
    res.json({ token, address, expiresAt: expires.toISOString(), stakeholder: await readStakeholder(address) });
  }),
);

authRouter.get(
  "/me",
  requireDb,
  requireSession,
  wrap(async (req, res) => {
    res.json({ address: req.session.address, stakeholder: await readStakeholder(req.session.address) });
  }),
);

authRouter.post(
  "/logout",
  requireDb,
  requireSession,
  wrap(async (req, res) => {
    await query("DELETE FROM sessions WHERE token = $1", [req.session.token]);
    res.json({ ok: true });
  }),
);

/** Express middleware: requires `Authorization: Bearer <token>`. */
export async function requireSession(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "missing bearer token" });
    const r = await query("SELECT token, address, expires_at FROM sessions WHERE token = $1", [token]);
    if (!r.rowCount || new Date(r.rows[0].expires_at) < new Date()) return res.status(401).json({ error: "invalid or expired session" });
    req.session = { token, address: r.rows[0].address };
    next();
  } catch (err) {
    next(err);
  }
}

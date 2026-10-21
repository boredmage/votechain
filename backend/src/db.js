/**
 * PostgreSQL access. When DATABASE_URL is not configured the backend runs in "chain-only" mode:
 * every endpoint that reads the blockchain directly (election, units, disputes, chain trace, IPFS)
 * keeps working, while the cached feeds (activity, notifications, sessions) report 503.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { config, backendRoot } from "./config.js";

let pool = null;

export function hasDb() {
  return Boolean(config.databaseUrl);
}

export function getPool() {
  if (!hasDb()) return null;
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
    pool.on("error", (err) => console.error("[db] idle client error", err.message));
  }
  return pool;
}

export async function query(text, params = []) {
  const p = getPool();
  if (!p) throw Object.assign(new Error("database not configured (set DATABASE_URL)"), { status: 503 });
  return p.query(text, params);
}

export async function migrate() {
  const p = getPool();
  if (!p) return false;
  const sql = readFileSync(join(backendRoot, "schema.sql"), "utf8");
  await p.query(sql);
  return true;
}

export async function closeDb() {
  if (pool) await pool.end();
  pool = null;
}

/** Express middleware: 503 when the database is not configured. */
export function requireDb(_req, res, next) {
  if (!hasDb()) {
    return res.status(503).json({ error: "This endpoint needs PostgreSQL. Set DATABASE_URL (see docker-compose.yml) and restart the backend." });
  }
  next();
}

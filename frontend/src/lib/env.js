/**
 * Frontend configuration. Vite inlines VITE_* variables at build time; a static deployment can
 * also override them at runtime by defining `window.__VOTECHAIN_ENV__ = { VITE_API_URL: "..." }`
 * before the bundle loads (handy for Docker images built once and configured per environment).
 */
const buildTime = (typeof import.meta !== "undefined" && import.meta.env) || {};
const runtime = (typeof globalThis !== "undefined" && globalThis.__VOTECHAIN_ENV__) || {};
const pick = (key, fallback) => runtime[key] ?? buildTime[key] ?? fallback;

export const env = {
  DEV: Boolean(buildTime.DEV),
  API_URL: pick("VITE_API_URL", ""),
  RPC_URL: pick("VITE_RPC_URL", "http://127.0.0.1:8545"),
  CHAIN_ID: Number(pick("VITE_CHAIN_ID", 31337)),
  NETWORK: pick("VITE_NETWORK", "localhost"),
  DEMO_MODE: String(pick("VITE_DEMO_MODE", "true")) === "true",
};

/** Thin client for the VoteChain backend (read model, IPFS pipeline, notifications). */
import { env } from "./env.js";

// In `vite dev` the /api prefix is proxied to the backend (same origin); otherwise call it directly.
const BASE = (env.API_URL && !env.DEV ? env.API_URL : "").replace(/\/$/, "");

let sessionToken = null;
export function setSessionToken(t) {
  sessionToken = t;
  try {
    if (t) sessionStorage.setItem("votechain.session", t);
    else sessionStorage.removeItem("votechain.session");
  } catch {
    /* storage unavailable */
  }
}
export function getSessionToken() {
  if (sessionToken) return sessionToken;
  try {
    sessionToken = sessionStorage.getItem("votechain.session");
  } catch {
    /* ignore */
  }
  return sessionToken;
}

async function request(path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (!(opts.body instanceof FormData) && opts.body !== undefined) headers["Content-Type"] = "application/json";
  const token = getSessionToken();
  if (token && opts.auth !== false) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body instanceof FormData ? opts.body : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const err = new Error(data?.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  health: () => request("/api/health"),
  config: () => request("/api/config"),
  election: () => request("/api/election"),
  geography: () => request("/api/election/geography"),
  unit: (level, id) => request(`/api/units/${level}/${id}`),
  validatePu: (id, figures) => request(`/api/units/pu/${id}/validate`, { method: "POST", body: { figures } }),
  checkCollation: (level, id, figures) => request(`/api/units/${level}/${id}/check-collation`, { method: "POST", body: { figures } }),
  disputes: (status) => request(`/api/disputes${status ? `?status=${status}` : ""}`),
  escalated: () => request("/api/disputes/escalated"),
  dispute: (id) => request(`/api/disputes/${id}`),
  audit: () => request("/api/audit"),
  chain: () => request("/api/chain"),
  verify: (level, id) => request(`/api/verify/${level}/${id}`),
  stakeholder: (address) => request(`/api/stakeholders/${address}`),
  stakeholders: (params = {}) => request(`/api/stakeholders?${new URLSearchParams(params)}`),
  demoAccounts: () => request("/api/demo-accounts"),
  activity: (params = {}) => request(`/api/activity?${new URLSearchParams(params)}`),
  alerts: () => request("/api/alerts"),
  summary: () => request("/api/summary"),
  ipfsUpload: (file, purpose, uploader) => {
    const fd = new FormData();
    fd.append("file", file);
    if (purpose) fd.append("purpose", purpose);
    if (uploader) fd.append("uploader", uploader);
    return request("/api/ipfs/upload", { method: "POST", body: fd });
  },
  ipfsUrl: (cid) => `${BASE}/api/ipfs/${cid}`,
  ipfsExists: (cid) => request(`/api/ipfs/${cid}/exists`),
  authNonce: (address) => request("/api/auth/nonce", { method: "POST", body: { address }, auth: false }),
  authVerify: (address, signature) => request("/api/auth/verify", { method: "POST", body: { address, signature }, auth: false }),
  me: () => request("/api/auth/me"),
  notifications: (unreadOnly = false) => request(`/api/notifications${unreadOnly ? "?unread=true" : ""}`),
  markRead: (id) => request(`/api/notifications/${id}/read`, { method: "POST" }),
  markAllRead: () => request("/api/notifications/read-all", { method: "POST" }),
  credentialMessage: (address) => request(`/api/credentials/message/${address}`),
  issueCredential: (address, signature, payload) => request("/api/credentials/issue", { method: "POST", body: { address, signature, payload } }),
  verifyCredential: (payload, signature) => request("/api/credentials/verify", { method: "POST", body: { payload, signature } }),
  credentials: (address) => request(`/api/credentials/${address}`),
};

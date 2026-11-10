/**
 * Public JSON-RPC endpoint for the browser (POST /api/rpc).
 *
 * The frontend reads the chain and broadcasts signed transactions through VITE_RPC_URL. On a public
 * deployment the node itself (Anvil) must not be exposed: its anvil_* / evm_* / hardhat_* methods can
 * reset or rewind the chain, and its eth_sendTransaction signs for unlocked accounts. This forwards
 * only standard read methods and eth_sendRawTransaction (already signed by the caller) to RPC_URL.
 */
import { Router } from "express";
import { config } from "../config.js";

const ALLOWED = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getBlockReceipts",
  "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber",
  "eth_getCode",
  "eth_getFilterChanges",
  "eth_getFilterLogs",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_newBlockFilter",
  "eth_newFilter",
  "eth_sendRawTransaction",
  "eth_syncing",
  "eth_uninstallFilter",
  "net_listening",
  "net_version",
  "web3_clientVersion",
]);
const MAX_BATCH = 100;

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export const rpcRouter = Router();

rpcRouter.post("/", async (req, res) => {
  const body = req.body;
  const batch = Array.isArray(body);
  const calls = batch ? body : [body];
  if (!calls.length || calls.length > MAX_BATCH || calls.some((c) => !c || typeof c !== "object")) {
    return res.status(400).json(rpcError(null, -32600, "invalid request"));
  }

  const blocked = new Map();
  const forward = [];
  for (const call of calls) {
    if (typeof call.method === "string" && ALLOWED.has(call.method)) forward.push(call);
    else blocked.set(call, rpcError(call.id, -32601, `method not allowed: ${String(call.method)}`));
  }

  let results = [];
  if (forward.length) {
    try {
      const upstream = await fetch(config.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(forward),
        signal: AbortSignal.timeout(30_000),
      });
      results = await upstream.json();
      if (!Array.isArray(results)) results = [results];
    } catch (err) {
      console.error("[rpc]", err.message);
      results = forward.map((c) => rpcError(c.id, -32603, "chain unavailable"));
    }
  }

  // Answer in request order; the node matches batch responses by id, not position.
  const byId = new Map(results.map((r) => [JSON.stringify(r?.id ?? null), r]));
  const out = calls.map(
    (c) => blocked.get(c) ?? byId.get(JSON.stringify(c.id ?? null)) ?? rpcError(c.id, -32603, "no response"),
  );
  res.json(batch ? out : out[0]);
});

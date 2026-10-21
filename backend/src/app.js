import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { getChain } from "./chain.js";
import { hasDb } from "./db.js";
import { electionRouter } from "./routes/election.js";
import { ipfsRouter, ipfsProvider } from "./routes/ipfs.js";
import { authRouter } from "./routes/auth.js";
import { feedsRouter } from "./routes/feeds.js";
import { indexer } from "./indexer.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",") }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", async (_req, res) => {
    let chain = { ok: false };
    try {
      const { provider, deployment } = getChain();
      chain = { ok: true, chainId: deployment.chainId, network: deployment.network, blockNumber: await provider.getBlockNumber() };
    } catch (err) {
      chain = { ok: false, error: err.message };
    }
    res.json({ ok: chain.ok, chain, database: hasDb(), ipfsProvider: ipfsProvider.name, indexer: indexer.status(), time: new Date().toISOString() });
  });

  app.use("/api", electionRouter);
  app.use("/api/ipfs", ipfsRouter);
  app.use("/api/auth", authRouter);
  app.use("/api", feedsRouter);

  app.use((_req, res) => res.status(404).json({ error: "not found" }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.code === "LIMIT_FILE_SIZE" ? 413 : 500);
    if (status >= 500) console.error("[api]", err);
    res.status(status).json({ error: err.message || "internal error", ...(err.reason ? { reason: err.reason } : {}) });
  });
  return app;
}

import { config } from "./config.js";
import { createApp } from "./app.js";
import { migrate, hasDb, closeDb } from "./db.js";
import { getChain } from "./chain.js";
import { indexer } from "./indexer.js";

async function main() {
  const { deployment } = getChain();
  console.log(`[votechain] network=${deployment.network} chainId=${deployment.chainId} rpc=${config.rpcUrl}`);
  console.log(`[votechain] ElectionManager ${deployment.contracts.ElectionManager}`);
  if (hasDb()) {
    await migrate();
    console.log("[votechain] database schema ready");
  }
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[votechain] API listening on http://localhost:${config.port}/api (ipfs provider: ${config.ipfs.provider})`);
  });
  await indexer.start();

  const shutdown = async () => {
    indexer.stop();
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[votechain] fatal:", err.message);
  process.exit(1);
});

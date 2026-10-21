import { migrate, closeDb, hasDb } from "./db.js";

if (!hasDb()) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
await migrate();
console.log("schema applied");
await closeDb();

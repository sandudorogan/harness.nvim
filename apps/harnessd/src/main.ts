import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, writeConnectionManifest } from "./config.ts";
import { startHarnessServer } from "./server.ts";
import { openDatabase } from "./store/db.ts";

const { stateDir } = parseArgs(process.argv.slice(2));
mkdirSync(stateDir, { recursive: true });

const token = randomBytes(24).toString("hex");
const dbPath = join(stateDir, "harness.db");
const db = openDatabase(dbPath);

const handle = await startHarnessServer({ stateDir, db, token, port: 0 });
writeConnectionManifest(stateDir, handle.port, token);

await new Promise<void>((resolve) => {
  const stop = () => resolve();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
});

await handle.close();
db.close();

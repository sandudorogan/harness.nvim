import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function parseArgs(argv: string[]): { stateDir: string } {
  const i = argv.indexOf("--state-dir");
  if (i < 0 || argv[i + 1] === undefined) {
    throw new Error("missing required --state-dir <path>");
  }
  return { stateDir: argv[i + 1]! };
}

export function writeConnectionManifest(stateDir: string, port: number, token: string): void {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "manifest.json");
  const body = JSON.stringify({ port, token }) + "\n";
  writeFileSync(path, body, "utf8");
}

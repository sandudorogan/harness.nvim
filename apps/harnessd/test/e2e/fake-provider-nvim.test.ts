import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "../../../..");

const tmpRoot = mkdtempSync(join(tmpdir(), "harnessd-e2e-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        readFileSync(path, "utf8");
        resolve();
        return;
      } catch {
        /* not ready */
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timeout waiting for ${path}`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe("e2e: headless nvim and fake provider", () => {
  test("daemon manifest, nvim connects, prompt yields transcript output file", async () => {
    const stateDir = join(tmpRoot, "e2e1");
    const outFile = join(stateDir, "transcript_out.txt");
    const mainTs = join(repoRoot, "apps/harnessd/src/main.ts");

    const daemon = Bun.spawn({
      cmd: ["bun", mainTs, "--state-dir", stateDir],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    try {
      const manifestPath = join(stateDir, "manifest.json");
      await waitForFile(manifestPath, 15_000);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        port: number;
        token: string;
      };
      expect(typeof manifest.port).toBe("number");
      expect(typeof manifest.token).toBe("string");

      const luaPath = join(__dirname, "nvim_fake_client.lua");
      const nvim = Bun.spawn({
        cmd: [
          "nvim",
          "--headless",
          "-u",
          "NONE",
          "-n",
          "-c",
          "lua dofile(os.getenv('HARNESS_NVIM_LUA'))",
          "+qall!",
        ],
        cwd: repoRoot,
        env: {
          ...process.env,
          HARNESS_MANIFEST: manifestPath,
          HARNESS_TRANSCRIPT_OUT: outFile,
          HARNESS_NVIM_LUA: luaPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const nvimCode = await nvim.exited;
      if (nvimCode !== 0) {
        const err = await new Response(nvim.stderr).text();
        const out = await new Response(nvim.stdout).text();
        throw new Error(`nvim exited ${nvimCode}: stderr=${err} stdout=${out}`);
      }

      await waitForFile(outFile, 10_000);
      const text = readFileSync(outFile, "utf8");
      expect(text).toContain("Fake");
    } finally {
      daemon.kill();
      await daemon.exited;
    }
  }, 60_000);
});

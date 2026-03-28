import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeConnectionManifest } from "../../src/config.ts";
import { encodeFrame, FrameDecoder } from "../../src/protocol/encode.ts";
import type { ClientResponse } from "../../src/protocol/types.ts";
import { isDaemonEvent, isResponse } from "../../src/protocol/types.ts";
import { startHarnessServer } from "../../src/server.ts";
import { openDatabase } from "../../src/store/db.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "../../../..");

const tmpRoot = mkdtempSync(join(tmpdir(), "harnessd-e2e-mc-"));

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

type HarnessConn = {
  sock: Socket;
  send: (obj: unknown) => void;
  nextMessage: () => Promise<unknown>;
  close: () => void;
};

function connectHarness(port: number): Promise<HarnessConn> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port }, () => {
      const dec = new FrameDecoder();
      const queue: unknown[] = [];
      const waiters: Array<(v: unknown) => void> = [];

      const pump = (chunk: Buffer) => {
        const u8 = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        for (const json of dec.push(u8)) {
          const v = JSON.parse(json) as unknown;
          const w = waiters.shift();
          if (w) w(v);
          else queue.push(v);
        }
      };

      sock.on("data", pump);

      const nextMessage = (): Promise<unknown> => {
        const q = queue.shift();
        if (q !== undefined) return Promise.resolve(q);
        return new Promise((r) => waiters.push(r));
      };

      resolve({
        sock,
        send: (obj: unknown) => {
          sock.write(encodeFrame(obj));
        },
        nextMessage,
        close: () => sock.destroy(),
      });
    });
    sock.on("error", reject);
  });
}

async function expectResponse(conn: HarnessConn, requestId: string): Promise<ClientResponse> {
  while (true) {
    const m = await conn.nextMessage();
    if (isResponse(m) && m.replyTo === requestId) {
      return m;
    }
    if (isDaemonEvent(m)) {
      continue;
    }
    throw new Error(`expected response for ${requestId}, got ${JSON.stringify(m)}`);
  }
}

describe("e2e: session restore and multi-client", () => {
  test("lists persisted sessions after daemon restart", async () => {
    const stateDir = join(tmpRoot, "list-restart");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "harness.db");
    const token = "test-token-mc-list";

    let db = openDatabase(dbPath);
    let handle = await startHarnessServer({ stateDir, db, token, port: 0 });

    try {
      const conn = await connectHarness(handle.port);
      try {
        conn.send({ id: "h1", method: "daemon.hello", params: { token } });
        const hello = await expectResponse(conn, "h1");
        expect(hello.ok).toBe(true);

        conn.send({
          id: "c1",
          method: "session.create",
          params: { workspaceRoot: "/tmp/harness_mc_list", provider: "fake", metadata: {} },
        });
        const c1 = await expectResponse(conn, "c1");
        expect(c1.ok).toBe(true);
        if (!c1.ok) throw new Error("session.create failed");
        const sessionId = (c1.result as { sessionId: string }).sessionId;
        expect(typeof sessionId).toBe("string");
      } finally {
        conn.close();
      }
    } finally {
      await handle.close();
      db.close();
    }

    db = openDatabase(dbPath);
    handle = await startHarnessServer({ stateDir, db, token, port: 0 });

    try {
      const conn2 = await connectHarness(handle.port);
      try {
        conn2.send({ id: "h2", method: "daemon.hello", params: { token } });
        const hello2 = await expectResponse(conn2, "h2");
        expect(hello2.ok).toBe(true);

        conn2.send({ id: "l1", method: "session.list", params: {} });
        const lr = await expectResponse(conn2, "l1");
        expect(lr.ok).toBe(true);
        if (!lr.ok) throw new Error("session.list failed");
        const sessions = (lr.result as { sessions: Array<{ id: string }> }).sessions;
        expect(Array.isArray(sessions)).toBe(true);
        expect(sessions.length).toBeGreaterThanOrEqual(1);
      } finally {
        conn2.close();
      }
    } finally {
      await handle.close();
      db.close();
    }
  }, 90_000);

  test("reopens a prior session with session.resume after restart", async () => {
    const stateDir = join(tmpRoot, "resume-restart");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "harness.db");
    const token = "test-token-mc-resume";

    let savedSessionId: string;

    let db = openDatabase(dbPath);
    let handle = await startHarnessServer({ stateDir, db, token, port: 0 });

    try {
      const conn = await connectHarness(handle.port);
      try {
        conn.send({ id: "h1", method: "daemon.hello", params: { token } });
        await expectResponse(conn, "h1");

        conn.send({
          id: "c1",
          method: "session.create",
          params: { workspaceRoot: "/tmp/harness_mc_resume", provider: "fake", metadata: {} },
        });
        const c1 = await expectResponse(conn, "c1");
        expect(c1.ok).toBe(true);
        if (!c1.ok) throw new Error("session.create failed");
        savedSessionId = (c1.result as { sessionId: string }).sessionId;
      } finally {
        conn.close();
      }
    } finally {
      await handle.close();
      db.close();
    }

    db = openDatabase(dbPath);
    handle = await startHarnessServer({ stateDir, db, token, port: 0 });

    try {
      const conn2 = await connectHarness(handle.port);
      try {
        conn2.send({ id: "h2", method: "daemon.hello", params: { token } });
        await expectResponse(conn2, "h2");

        conn2.send({ id: "r1", method: "session.resume", params: { sessionId: savedSessionId } });
        const rr = await expectResponse(conn2, "r1");
        expect(rr.ok).toBe(true);
        if (!rr.ok) throw new Error("session.resume failed");

        conn2.send({
          id: "p1",
          method: "session.prompt",
          params: { sessionId: savedSessionId, text: "ping" },
        });
        const pr = await expectResponse(conn2, "p1");
        expect(pr.ok).toBe(true);
      } finally {
        conn2.close();
      }
    } finally {
      await handle.close();
      db.close();
    }
  }, 90_000);

  test("second headless nvim attaches to an existing session (two processes)", async () => {
    const stateDir = join(tmpRoot, "nvim-two");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "harness.db");
    const token = "test-token-mc-nvim";

    const db = openDatabase(dbPath);
    const handle = await startHarnessServer({ stateDir, db, token, port: 0 });
    writeConnectionManifest(stateDir, handle.port, token);

    const manifestPath = join(stateDir, "manifest.json");
    const donePath = join(stateDir, "nvim1_done.txt");
    const stopPath = join(stateDir, "nvim1_stop.txt");
    const attachOut = join(stateDir, "attach_out.txt");

    try {
      const lua1 = join(__dirname, "nvim_multi_client_1.lua");
      const nvim1 = Bun.spawn({
        cmd: [
          "nvim",
          "--headless",
          "-u",
          "NONE",
          "-n",
          "-c",
          "lua dofile(os.getenv('HARNESS_NVIM_LUA'))",
        ],
        cwd: repoRoot,
        env: {
          ...process.env,
          HARNESS_MANIFEST: manifestPath,
          HARNESS_NVIM_LUA: lua1,
          HARNESS_DONE_FILE: donePath,
          HARNESS_STOP_FILE: stopPath,
        },
        stdout: "ignore",
        stderr: "ignore",
      });

      await waitForFile(donePath, 20_000);

      const lua2 = join(__dirname, "nvim_multi_client_2.lua");
      const nvim2 = Bun.spawn({
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
          HARNESS_NVIM_LUA: lua2,
          HARNESS_ATTACH_OUT: attachOut,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const code2 = await nvim2.exited;
      if (code2 !== 0) {
        const err = await new Response(nvim2.stderr).text();
        const out = await new Response(nvim2.stdout).text();
        throw new Error(`nvim2 exited ${code2}: stderr=${err} stdout=${out}`);
      }

      await waitForFile(attachOut, 10_000);
      const attachText = readFileSync(attachOut, "utf8");
      expect(attachText.trim()).toBe("ok");

      writeFileSync(stopPath, "stop");

      const code1 = await nvim1.exited;
      if (code1 !== 0) {
        const err = await new Response(nvim1.stderr).text();
        const out = await new Response(nvim1.stdout).text();
        throw new Error(`nvim1 exited ${code1}: stderr=${err} stdout=${out}`);
      }
    } finally {
      await handle.close();
      db.close();
    }
  }, 120_000);
});

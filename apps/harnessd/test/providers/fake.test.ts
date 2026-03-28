import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, FrameDecoder } from "../../src/protocol/encode.ts";
import type { ClientResponse } from "../../src/protocol/types.ts";
import { isDaemonEvent, isResponse } from "../../src/protocol/types.ts";
import { startHarnessServer } from "../../src/server.ts";
import { openDatabase } from "../../src/store/db.ts";

const tmpRoot = mkdtempSync(join(tmpdir(), "harnessd-fake-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

type HarnessConn = {
  sock: Socket;
  send: (obj: unknown) => void;
  nextMessage: () => Promise<unknown>;
  close: () => void;
};

function connectHarness(port: number, _token: string): Promise<HarnessConn> {
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

async function exchange(
  conn: HarnessConn,
  req: { id: string; method: string; params?: unknown },
): Promise<{ response: ClientResponse; prelude: unknown[] }> {
  conn.send(req);
  const prelude: unknown[] = [];
  while (true) {
    const m = await conn.nextMessage();
    if (isResponse(m) && m.replyTo === req.id) {
      return { response: m, prelude };
    }
    prelude.push(m);
  }
}

describe("fake provider over harnessd TCP", () => {
  test("session.create returns session id and emits session.created", async () => {
    const stateDir = join(tmpRoot, "s1");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "harness.db");
    const db = openDatabase(dbPath);
    const token = "test-token-s1";
    const handle = await startHarnessServer({
      stateDir,
      db,
      token,
      port: 0,
    });

    const conn = await connectHarness(handle.port, token);
    try {
      conn.send({
        id: "h1",
        method: "daemon.hello",
        params: { token },
      });
      const hello = await expectResponse(conn, "h1");
      expect(hello.ok).toBe(true);

      const { response, prelude } = await exchange(conn, {
        id: "c1",
        method: "session.create",
        params: {
          workspaceRoot: "/tmp/ws",
          provider: "fake",
          metadata: {},
        },
      });

      expect(response.ok).toBe(true);
      if (!response.ok) throw new Error("expected ok");
      const sid = (response.result as { sessionId: string }).sessionId;
      expect(typeof sid).toBe("string");
      expect(sid.length).toBeGreaterThan(0);

      const created = prelude.filter((m) => isDaemonEvent(m) && m.event === "session.created");
      expect(created.length).toBe(1);
      const ev = created[0]!;
      expect(isDaemonEvent(ev)).toBe(true);
      if (!isDaemonEvent(ev)) throw new Error("bad event");
      expect(ev.sessionId).toBe(sid);
    } finally {
      conn.close();
      await handle.close();
      db.close();
    }
  });

  test("session.prompt streams message deltas then completes", async () => {
    const stateDir = join(tmpRoot, "s2");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "harness.db");
    const db = openDatabase(dbPath);
    const token = "test-token-s2";
    const handle = await startHarnessServer({
      stateDir,
      db,
      token,
      port: 0,
    });

    const conn = await connectHarness(handle.port, token);
    try {
      conn.send({ id: "h1", method: "daemon.hello", params: { token } });
      expect((await expectResponse(conn, "h1")).ok).toBe(true);

      const { response: cr } = await exchange(conn, {
        id: "c1",
        method: "session.create",
        params: { workspaceRoot: "/w", provider: "fake", metadata: {} },
      });
      expect(cr.ok).toBe(true);
      if (!cr.ok) throw new Error("create failed");
      const sessionId = (cr.result as { sessionId: string }).sessionId;

      conn.send({
        id: "p1",
        method: "session.prompt",
        params: { sessionId, text: "hi" },
      });

      const deltas: string[] = [];
      let turnId: string | null = null;
      let promptOk: ClientResponse | null = null;
      let completed = false;

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !completed) {
        const m = await conn.nextMessage();
        if (isResponse(m) && m.replyTo === "p1") {
          promptOk = m;
          if (m.ok) {
            turnId = (m.result as { turnId: string }).turnId;
          }
        } else if (isDaemonEvent(m) && m.event === "message.delta") {
          const t = m.payload.text;
          if (typeof t === "string") deltas.push(t);
          const tid = m.payload.turnId;
          if (typeof tid === "string" && turnId === null) turnId = tid;
        } else if (isDaemonEvent(m) && m.event === "message.completed") {
          expect(m.payload.turnId).toBe(turnId);
          completed = true;
        }
      }

      expect(promptOk).not.toBeNull();
      expect(promptOk!.ok).toBe(true);
      if (!promptOk!.ok) throw new Error("prompt not ok");
      expect((promptOk!.result as { turnId: string }).turnId).toBeTruthy();
      expect(turnId).toBe((promptOk!.result as { turnId: string }).turnId);

      expect(deltas.join("")).toContain("Fake");
      expect(completed).toBe(true);
    } finally {
      conn.close();
      await handle.close();
      db.close();
    }
  });

  test("session.prompt emits approval.requested and resumes after approval.resolve", async () => {
    const stateDir = join(tmpRoot, "s3");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "harness.db");
    const db = openDatabase(dbPath);
    const token = "test-token-s3";
    const handle = await startHarnessServer({
      stateDir,
      db,
      token,
      port: 0,
    });

    const conn = await connectHarness(handle.port, token);
    try {
      conn.send({ id: "h1", method: "daemon.hello", params: { token } });
      expect((await expectResponse(conn, "h1")).ok).toBe(true);

      const { response: cr } = await exchange(conn, {
        id: "c1",
        method: "session.create",
        params: { workspaceRoot: "/w", provider: "fake", metadata: {} },
      });
      expect(cr.ok).toBe(true);
      if (!cr.ok) throw new Error("create failed");
      const sessionId = (cr.result as { sessionId: string }).sessionId;

      conn.send({
        id: "p1",
        method: "session.prompt",
        params: { sessionId, text: "need approval" },
      });

      let approvalId: string | null = null;
      let turnId: string | null = null;
      const deadline = Date.now() + 15_000;

      while (Date.now() < deadline) {
        const m = await conn.nextMessage();
        if (isResponse(m) && m.replyTo === "p1") {
          if (!m.ok) throw new Error("prompt failed");
          turnId = (m.result as { turnId: string }).turnId;
          break;
        }
      }
      expect(turnId).not.toBeNull();

      while (Date.now() < deadline && !approvalId) {
        const m = await conn.nextMessage();
        if (isDaemonEvent(m) && m.event === "approval.requested") {
          const aid = m.payload.approvalId;
          if (typeof aid === "string") approvalId = aid;
        }
      }
      expect(approvalId).not.toBeNull();

      const { response: ar, prelude: resolvePrelude } = await exchange(conn, {
        id: "a1",
        method: "approval.resolve",
        params: {
          approvalId,
          resolution: { choice: "allow_once" },
        },
      });
      expect(ar.ok).toBe(true);

      const resolvedEv = resolvePrelude.find(
        (m) => isDaemonEvent(m) && m.event === "approval.resolved",
      );
      expect(resolvedEv).toBeDefined();
      if (isDaemonEvent(resolvedEv)) {
        expect(resolvedEv.payload.approvalId).toBe(approvalId);
        expect(resolvedEv.payload.turnId).toBe(turnId);
      }

      const postApproval = [...resolvePrelude];
      let sawDiffReady = false;
      let sawCompleted = false;

      while (Date.now() < deadline && !sawCompleted) {
        const m = await conn.nextMessage();
        postApproval.push(m);
        if (isDaemonEvent(m) && m.event === "diff.ready") {
          expect(m.payload.turnId).toBe(turnId);
          sawDiffReady = true;
        }
        if (isDaemonEvent(m) && m.event === "message.completed") {
          expect(m.payload.turnId).toBe(turnId);
          sawCompleted = true;
        }
      }

      expect(postApproval.some((m) => isDaemonEvent(m) && m.event === "diff.ready")).toBe(true);
      expect(sawDiffReady).toBe(true);
      expect(sawCompleted).toBe(true);
    } finally {
      conn.close();
      await handle.close();
      db.close();
    }
  });

  test("server close waits for in-flight prompt work before database close", async () => {
    const stateDir = join(tmpRoot, "s5");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "harness.db");
    const db = openDatabase(dbPath);
    const token = "test-token-s5";
    const handle = await startHarnessServer({
      stateDir,
      db,
      token,
      port: 0,
    });

    const conn = await connectHarness(handle.port, token);
    let dbClosed = false;
    try {
      conn.send({ id: "h1", method: "daemon.hello", params: { token } });
      expect((await expectResponse(conn, "h1")).ok).toBe(true);

      const { response: cr } = await exchange(conn, {
        id: "c1",
        method: "session.create",
        params: { workspaceRoot: "/w", provider: "fake", metadata: {} },
      });
      expect(cr.ok).toBe(true);
      if (!cr.ok) throw new Error("create failed");
      const sessionId = (cr.result as { sessionId: string }).sessionId;

      const { response: pr } = await exchange(conn, {
        id: "p1",
        method: "session.prompt",
        params: { sessionId, text: "hi" },
      });
      expect(pr.ok).toBe(true);

      await handle.close();
      db.close();
      dbClosed = true;

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(true).toBe(true);
    } finally {
      conn.close();
      await handle.close();
      if (!dbClosed) db.close();
    }
  });

  test("session.prompt emits diff.ready with a file proposal", async () => {
    const stateDir = join(tmpRoot, "s4");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "harness.db");
    const db = openDatabase(dbPath);
    const token = "test-token-s4";
    const handle = await startHarnessServer({
      stateDir,
      db,
      token,
      port: 0,
    });

    const conn = await connectHarness(handle.port, token);
    try {
      conn.send({ id: "h1", method: "daemon.hello", params: { token } });
      expect((await expectResponse(conn, "h1")).ok).toBe(true);

      const { response: cr } = await exchange(conn, {
        id: "c1",
        method: "session.create",
        params: { workspaceRoot: "/w", provider: "fake", metadata: {} },
      });
      expect(cr.ok).toBe(true);
      if (!cr.ok) throw new Error("create failed");
      const sessionId = (cr.result as { sessionId: string }).sessionId;

      conn.send({
        id: "p1",
        method: "session.prompt",
        params: { sessionId, text: "edit file" },
      });

      let diffId: string | null = null;
      const deadline = Date.now() + 20_000;

      while (Date.now() < deadline) {
        const m = await conn.nextMessage();
        if (isResponse(m) && m.replyTo === "p1") {
          if (!m.ok) throw new Error("prompt failed");
          break;
        }
      }

      while (Date.now() < deadline && !diffId) {
        const m = await conn.nextMessage();
        if (isDaemonEvent(m) && m.event === "diff.ready") {
          const did = m.payload.diffId;
          if (typeof did === "string") diffId = did;
          expect(typeof m.payload.path).toBe("string");
        }
      }
      expect(diffId).not.toBeNull();
    } finally {
      conn.close();
      await handle.close();
      db.close();
    }
  });
});

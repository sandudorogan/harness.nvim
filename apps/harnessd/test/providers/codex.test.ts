import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, FrameDecoder } from "../../src/protocol/encode.ts";
import type { ClientResponse } from "../../src/protocol/types.ts";
import { isDaemonEvent, isResponse } from "../../src/protocol/types.ts";
import {
  CodexJsonRpcSession,
  CodexProviderAdapter,
  type LineTransport,
  spawnCodexAppServerTransport,
} from "../../src/providers/codex/adapter.ts";
import { startHarnessServer } from "../../src/server.ts";
import { openDatabase } from "../../src/store/db.ts";
import { resumeSessionById } from "../../src/store/sessions.ts";

const tmpRoot = mkdtempSync(join(tmpdir(), "harnessd-codex-"));

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

/** Scripted Codex app-server over in-memory lines (JSONL). */
function createMockCodexLineTransport(
  script: (ctx: {
    nextClientJson: () => Promise<Record<string, unknown>>;
    reply: (obj: unknown) => void;
  }) => Promise<void>,
  opts?: { onClientMessage?: (msg: Record<string, unknown>) => void },
): LineTransport {
  const clientToServer: string[] = [];
  const clientWaiters: Array<(line: string) => void> = [];
  const serverToClient: string[] = [];
  const serverWaiters: Array<(line: string) => void> = [];
  let closed = false;

  const _wakeClient = () => {
    const line = serverToClient.shift();
    if (line !== undefined) {
      const w = serverWaiters.shift();
      if (w) w(line);
    }
  };

  void script({
    nextClientJson: () =>
      new Promise((resolve, reject) => {
        const take = () => {
          const line = clientToServer.shift();
          if (line !== undefined) {
            try {
              resolve(JSON.parse(line) as Record<string, unknown>);
            } catch (e) {
              reject(e);
            }
            return;
          }
          clientWaiters.push((l) => {
            try {
              resolve(JSON.parse(l) as Record<string, unknown>);
            } catch (e) {
              reject(e);
            }
          });
        };
        take();
      }),
    reply: (obj: unknown) => {
      serverToClient.push(`${JSON.stringify(obj)}\n`);
      const w = serverWaiters.shift();
      if (w) {
        const line = serverToClient.shift()!;
        w(line);
      }
    },
  });

  return {
    writeLine(line: string) {
      if (closed) return;
      const bare = line.endsWith("\n") ? line.slice(0, -1) : line;
      opts?.onClientMessage?.(JSON.parse(bare) as Record<string, unknown>);
      const w = clientWaiters.shift();
      if (w) w(bare);
      else clientToServer.push(bare);
    },
    readLine(): Promise<string> {
      if (closed) return Promise.resolve("");
      const line = serverToClient.shift();
      if (line !== undefined) {
        const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
        return Promise.resolve(trimmed);
      }
      return new Promise((resolve) => {
        serverWaiters.push((l) => {
          const trimmed = l.endsWith("\n") ? l.slice(0, -1) : l;
          resolve(trimmed);
        });
      });
    },
    close: async () => {
      closed = true;
      for (const w of serverWaiters.splice(0)) {
        w("");
      }
    },
  };
}

describe("Codex provider over harnessd TCP (mocked stdio)", () => {
  test("CodexJsonRpcSession rejects pending requests on EOF", async () => {
    const transport: LineTransport = {
      writeLine() {},
      readLine: () => Promise.resolve(""),
      close: async () => {},
    };

    const rpc = new CodexJsonRpcSession(transport);
    const request = rpc.request("initialize", {});

    await expect(request).rejects.toThrow();
    await rpc.close();
  });

  test("archiveSession closes rpc transport when thread/archive fails", async () => {
    let closed = false;
    let nextLine: ((line: string) => void) | null = null;
    const transport: LineTransport = {
      writeLine(line: string) {
        const msg = JSON.parse(line) as { method?: string; id?: unknown };
        if (msg.method === "thread/archive") {
          nextLine?.(
            JSON.stringify({
              id: msg.id,
              error: { code: 123, message: "archive blew up" },
            }),
          );
        }
      },
      readLine() {
        return new Promise((resolve) => {
          nextLine = resolve;
        });
      },
      close: async () => {
        closed = true;
        nextLine?.("");
      },
    };

    const rpc = new CodexJsonRpcSession(transport);
    const adapter = new CodexProviderAdapter(rpc, {
      harnessSessionId: "s1",
      threadId: "thr_1",
      workspaceRoot: "/tmp",
      model: "gpt-5.4",
    });

    await expect(adapter.archiveSession()).rejects.toThrow("archive blew up");
    expect(closed).toBe(true);
  });

  test("spawnCodexAppServerTransport resolves pending readLine on EOF without trailing data", async () => {
    const binDir = mkdtempSync(join(tmpRoot, "codex-bin-"));
    const fakeCodex = join(binDir, "codex");
    writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeCodex, 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    try {
      const transport = spawnCodexAppServerTransport(tmpRoot);
      const line = await Promise.race([
        transport.readLine(),
        new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error("readLine did not resolve on EOF")), 1000);
        }),
      ]);
      expect(line).toBe("");
      await transport.close();
    } finally {
      if (prevPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = prevPath;
      }
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("session.create succeeds and persists Codex thread id", async () => {
    const stateDir = join(tmpRoot, "c1");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "harness.db");
    const db = openDatabase(dbPath);
    const token = "tok-c1";
    const threadId = "thr_unit_1";

    const handle = await startHarnessServer({
      stateDir,
      db,
      token,
      port: 0,
      codexLineTransportFactory: () =>
        createMockCodexLineTransport(async ({ nextClientJson, reply }) => {
          let m = await nextClientJson();
          expect(m.method).toBe("initialize");
          reply({
            id: m.id,
            result: { userAgent: "test", platformFamily: "test", platformOs: "test" },
          });
          m = await nextClientJson();
          expect(m.method).toBe("initialized");
          m = await nextClientJson();
          expect(m.method).toBe("thread/start");
          reply({
            id: m.id,
            result: {
              thread: {
                id: threadId,
                preview: "",
                ephemeral: false,
                modelProvider: "openai",
                createdAt: 1,
              },
            },
          });
          reply({ method: "thread/started", params: { thread: { id: threadId } } });
        }),
    });

    const conn = await connectHarness(handle.port, token);
    try {
      conn.send({ id: "h1", method: "daemon.hello", params: { token } });
      expect((await expectResponse(conn, "h1")).ok).toBe(true);

      const { response, prelude } = await exchange(conn, {
        id: "c1",
        method: "session.create",
        params: { workspaceRoot: "/tmp/ws-codex", provider: "codex", metadata: {} },
      });

      expect(response.ok).toBe(true);
      if (!response.ok) throw new Error("create failed");
      const sessionId = (response.result as { sessionId: string }).sessionId;
      expect(sessionId.length).toBeGreaterThan(0);

      const row = resumeSessionById(db, sessionId);
      expect(row).not.toBeNull();
      expect(row!.provider).toBe("codex");
      expect(row!.providerSessionId).toBe(threadId);

      const created = prelude.filter((x) => isDaemonEvent(x) && x.event === "session.created");
      expect(created.length).toBe(1);
    } finally {
      conn.close();
      await handle.close();
      db.close();
    }
  });

  test("session.prompt streams message.delta then message.completed", async () => {
    const stateDir = join(tmpRoot, "c2");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "harness.db");
    const db = openDatabase(dbPath);
    const token = "tok-c2";
    const threadId = "thr_unit_2";
    const codexTurnId = "turn_codex_2";

    const handle = await startHarnessServer({
      stateDir,
      db,
      token,
      port: 0,
      codexLineTransportFactory: () =>
        createMockCodexLineTransport(async ({ nextClientJson, reply }) => {
          let m = await nextClientJson();
          reply({ id: m.id, result: { userAgent: "t", platformFamily: "t", platformOs: "t" } });
          m = await nextClientJson();
          m = await nextClientJson();
          reply({
            id: m.id,
            result: {
              thread: {
                id: threadId,
                preview: "",
                ephemeral: false,
                modelProvider: "openai",
                createdAt: 1,
              },
            },
          });
          reply({ method: "thread/started", params: { thread: { id: threadId } } });

          m = await nextClientJson();
          expect(m.method).toBe("turn/start");
          reply({
            id: m.id,
            result: {
              turn: { id: codexTurnId, status: "inProgress", items: [], error: null },
            },
          });
          reply({ method: "turn/started", params: { turn: { id: codexTurnId, threadId } } });
          reply({
            method: "item/agentMessage/delta",
            params: {
              threadId,
              turnId: codexTurnId,
              itemId: "it1",
              delta: "hello ",
            },
          });
          reply({
            method: "item/agentMessage/delta",
            params: {
              threadId,
              turnId: codexTurnId,
              itemId: "it1",
              delta: "world",
            },
          });
          reply({
            method: "turn/completed",
            params: {
              threadId,
              turn: { id: codexTurnId, status: "completed", items: [], error: null },
            },
          });
        }),
    });

    const conn = await connectHarness(handle.port, token);
    try {
      conn.send({ id: "h1", method: "daemon.hello", params: { token } });
      expect((await expectResponse(conn, "h1")).ok).toBe(true);

      const { response: cr } = await exchange(conn, {
        id: "c1",
        method: "session.create",
        params: { workspaceRoot: "/w", provider: "codex", metadata: {} },
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
      let harnessTurnId: string | null = null;
      let completed = false;
      const deadline = Date.now() + 10_000;

      while (Date.now() < deadline && !completed) {
        const m = await conn.nextMessage();
        if (isResponse(m) && m.replyTo === "p1") {
          expect(m.ok).toBe(true);
          if (m.ok) harnessTurnId = (m.result as { turnId: string }).turnId;
        } else if (isDaemonEvent(m) && m.event === "message.delta") {
          const t = m.payload.text;
          if (typeof t === "string") deltas.push(t);
          expect(m.payload.provider).toBeDefined();
        } else if (isDaemonEvent(m) && m.event === "message.completed") {
          expect(m.payload.turnId).toBe(harnessTurnId);
          completed = true;
        }
      }

      expect(harnessTurnId).not.toBeNull();
      expect(deltas.join("")).toBe("hello world");
      expect(completed).toBe(true);
    } finally {
      conn.close();
      await handle.close();
      db.close();
    }
  });

  test("session.prompt waits on approval until approval.resolve", async () => {
    const stateDir = join(tmpRoot, "c3");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "harness.db");
    const db = openDatabase(dbPath);
    const token = "tok-c3";
    const threadId = "thr_unit_3";
    const codexTurnId = "turn_codex_3";
    const approvalReplies: Array<Record<string, unknown>> = [];

    let approvalRpcId: string | number | undefined;

    const handle = await startHarnessServer({
      stateDir,
      db,
      token,
      port: 0,
      codexLineTransportFactory: () =>
        createMockCodexLineTransport(
          async ({ nextClientJson, reply }) => {
            let m = await nextClientJson();
            reply({ id: m.id, result: { userAgent: "t", platformFamily: "t", platformOs: "t" } });
            m = await nextClientJson();
            m = await nextClientJson();
            reply({
              id: m.id,
              result: {
                thread: {
                  id: threadId,
                  preview: "",
                  ephemeral: false,
                  modelProvider: "openai",
                  createdAt: 1,
                },
              },
            });
            reply({ method: "thread/started", params: { thread: { id: threadId } } });

            m = await nextClientJson();
            reply({
              id: m.id,
              result: {
                turn: { id: codexTurnId, status: "inProgress", items: [], error: null },
              },
            });
            reply({ method: "turn/started", params: { turn: { id: codexTurnId, threadId } } });

            reply({
              method: "thread/status/changed",
              params: {
                threadId,
                status: { type: "active", activeFlags: ["waitingOnApproval"] },
              },
            });

            approvalRpcId = 777;
            reply({
              jsonrpc: "2.0",
              method: "tool/approvalRequest",
              id: approvalRpcId,
              params: { tool: "run_terminal_cmd", detail: { cmd: ["echo", "hi"] } },
            });

            m = await nextClientJson();
            expect(m.id).toBe(approvalRpcId);
            expect(m.result).toBeDefined();

            reply({
              method: "turn/completed",
              params: {
                threadId,
                turn: { id: codexTurnId, status: "completed", items: [], error: null },
              },
            });
          },
          {
            onClientMessage: (msg) => {
              if (approvalRpcId !== undefined && msg.id === approvalRpcId) {
                approvalReplies.push(msg);
              }
            },
          },
        ),
    });

    const conn = await connectHarness(handle.port, token);
    try {
      conn.send({ id: "h1", method: "daemon.hello", params: { token } });
      expect((await expectResponse(conn, "h1")).ok).toBe(true);

      const { response: cr } = await exchange(conn, {
        id: "c1",
        method: "session.create",
        params: { workspaceRoot: "/w", provider: "codex", metadata: {} },
      });
      expect(cr.ok).toBe(true);
      if (!cr.ok) throw new Error("create failed");
      const sessionId = (cr.result as { sessionId: string }).sessionId;

      conn.send({
        id: "p1",
        method: "session.prompt",
        params: { sessionId, text: "run something" },
      });

      let harnessTurnId: string | null = null;
      let approvalId: string | null = null;
      const deadline = Date.now() + 15_000;

      while (Date.now() < deadline && harnessTurnId === null) {
        const m = await conn.nextMessage();
        if (isResponse(m) && m.replyTo === "p1" && m.ok) {
          harnessTurnId = (m.result as { turnId: string }).turnId;
        }
      }
      expect(harnessTurnId).not.toBeNull();

      while (Date.now() < deadline && approvalId === null) {
        const m = await conn.nextMessage();
        if (isDaemonEvent(m) && m.event === "approval.requested") {
          approvalId = m.payload.approvalId as string;
          expect(m.payload.provider).toBeDefined();
        }
      }
      expect(approvalId).not.toBeNull();

      const { response: ar } = await exchange(conn, {
        id: "a1",
        method: "approval.resolve",
        params: { approvalId, resolution: { choice: "allow_once" } },
      });
      expect(ar.ok).toBe(true);

      let sawCompleted = false;
      while (Date.now() < deadline && !sawCompleted) {
        const m = await conn.nextMessage();
        if (isDaemonEvent(m) && m.event === "message.completed") {
          expect(m.payload.turnId).toBe(harnessTurnId);
          sawCompleted = true;
        }
      }
      expect(sawCompleted).toBe(true);
      expect(approvalReplies).toHaveLength(1);
      expect(approvalReplies[0]?.result).toEqual({ choice: "allow_once" });
    } finally {
      conn.close();
      await handle.close();
      db.close();
    }
  });

  test("session.resume reuses stored thread via thread/resume", async () => {
    const stateDir = join(tmpRoot, "c4");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "harness.db");
    const db = openDatabase(dbPath);
    const token = "tok-c4";
    const threadId = "thr_persist_4";

    let persistedSessionId = "";

    const handle = await startHarnessServer({
      stateDir,
      db,
      token,
      port: 0,
      codexLineTransportFactory: () =>
        createMockCodexLineTransport(async ({ nextClientJson, reply }) => {
          let m = await nextClientJson();
          reply({ id: m.id, result: { userAgent: "t", platformFamily: "t", platformOs: "t" } });
          m = await nextClientJson();
          m = await nextClientJson();
          reply({
            id: m.id,
            result: {
              thread: {
                id: threadId,
                preview: "",
                ephemeral: false,
                modelProvider: "openai",
                createdAt: 1,
              },
            },
          });
          reply({ method: "thread/started", params: { thread: { id: threadId } } });
        }),
    });

    const conn = await connectHarness(handle.port, token);
    try {
      conn.send({ id: "h1", method: "daemon.hello", params: { token } });
      expect((await expectResponse(conn, "h1")).ok).toBe(true);

      const { response: cr } = await exchange(conn, {
        id: "c1",
        method: "session.create",
        params: { workspaceRoot: "/w", provider: "codex", metadata: { x: 1 } },
      });
      expect(cr.ok).toBe(true);
      if (!cr.ok) throw new Error("create failed");
      persistedSessionId = (cr.result as { sessionId: string }).sessionId;
    } finally {
      conn.close();
      await handle.close();
      db.close();
    }

    const db2 = openDatabase(dbPath);
    const handle2 = await startHarnessServer({
      stateDir,
      db: db2,
      token,
      port: 0,
      codexLineTransportFactory: () =>
        createMockCodexLineTransport(async ({ nextClientJson, reply }) => {
          let m = await nextClientJson();
          reply({ id: m.id, result: { userAgent: "t", platformFamily: "t", platformOs: "t" } });
          m = await nextClientJson();
          m = await nextClientJson();
          expect(m.method).toBe("thread/resume");
          expect((m.params as { threadId?: string }).threadId).toBe(threadId);
          reply({
            id: m.id,
            result: { thread: { id: threadId, name: null, ephemeral: false } },
          });
          reply({ method: "thread/started", params: { thread: { id: threadId } } });
        }),
    });

    const conn2 = await connectHarness(handle2.port, token);
    try {
      conn2.send({ id: "h1", method: "daemon.hello", params: { token } });
      expect((await expectResponse(conn2, "h1")).ok).toBe(true);

      const { response: rr } = await exchange(conn2, {
        id: "r1",
        method: "session.resume",
        params: { sessionId: persistedSessionId },
      });
      expect(rr.ok).toBe(true);
    } finally {
      conn2.close();
      await handle2.close();
      db2.close();
    }
  });

  test("session.archive calls thread/archive when session is loaded", async () => {
    const stateDir = join(tmpRoot, "c5");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "harness.db");
    const db = openDatabase(dbPath);
    const token = "tok-c5";
    const threadId = "thr_arch_5";

    const handle = await startHarnessServer({
      stateDir,
      db,
      token,
      port: 0,
      codexLineTransportFactory: () =>
        createMockCodexLineTransport(async ({ nextClientJson, reply }) => {
          let m = await nextClientJson();
          reply({ id: m.id, result: { userAgent: "t", platformFamily: "t", platformOs: "t" } });
          m = await nextClientJson();
          m = await nextClientJson();
          reply({
            id: m.id,
            result: {
              thread: {
                id: threadId,
                preview: "",
                ephemeral: false,
                modelProvider: "openai",
                createdAt: 1,
              },
            },
          });
          reply({ method: "thread/started", params: { thread: { id: threadId } } });

          m = await nextClientJson();
          expect(m.method).toBe("thread/archive");
          expect((m.params as { threadId?: string }).threadId).toBe(threadId);
          reply({ id: m.id, result: {} });
          reply({ method: "thread/archived", params: { threadId } });
        }),
    });

    const conn = await connectHarness(handle.port, token);
    try {
      conn.send({ id: "h1", method: "daemon.hello", params: { token } });
      expect((await expectResponse(conn, "h1")).ok).toBe(true);

      const { response: cr } = await exchange(conn, {
        id: "c1",
        method: "session.create",
        params: { workspaceRoot: "/w", provider: "codex", metadata: {} },
      });
      expect(cr.ok).toBe(true);
      if (!cr.ok) throw new Error("create failed");
      const sessionId = (cr.result as { sessionId: string }).sessionId;

      const { response: ar } = await exchange(conn, {
        id: "a1",
        method: "session.archive",
        params: { sessionId },
      });
      expect(ar.ok).toBe(true);

      const row = resumeSessionById(db, sessionId);
      expect(row?.state).toBe("archived");
    } finally {
      conn.close();
      await handle.close();
      db.close();
    }
  });

  test("session.archive returns ARCHIVE_FAILED and keeps session active on Codex error", async () => {
    const stateDir = join(tmpRoot, "c6");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "harness.db");
    const db = openDatabase(dbPath);
    const token = "tok-c6";
    const threadId = "thr_arch_6";

    const handle = await startHarnessServer({
      stateDir,
      db,
      token,
      port: 0,
      codexLineTransportFactory: () =>
        createMockCodexLineTransport(async ({ nextClientJson, reply }) => {
          let m = await nextClientJson();
          reply({ id: m.id, result: { userAgent: "t", platformFamily: "t", platformOs: "t" } });
          m = await nextClientJson();
          m = await nextClientJson();
          reply({
            id: m.id,
            result: {
              thread: {
                id: threadId,
                preview: "",
                ephemeral: false,
                modelProvider: "openai",
                createdAt: 1,
              },
            },
          });
          reply({ method: "thread/started", params: { thread: { id: threadId } } });

          m = await nextClientJson();
          expect(m.method).toBe("thread/archive");
          reply({
            id: m.id,
            error: { code: 123, message: "archive blew up" },
          });
        }),
    });

    const conn = await connectHarness(handle.port, token);
    try {
      conn.send({ id: "h1", method: "daemon.hello", params: { token } });
      expect((await expectResponse(conn, "h1")).ok).toBe(true);

      const { response: cr } = await exchange(conn, {
        id: "c1",
        method: "session.create",
        params: { workspaceRoot: "/w", provider: "codex", metadata: {} },
      });
      expect(cr.ok).toBe(true);
      if (!cr.ok) throw new Error("create failed");
      const sessionId = (cr.result as { sessionId: string }).sessionId;

      const { response: ar } = await exchange(conn, {
        id: "a1",
        method: "session.archive",
        params: { sessionId },
      });
      expect(ar.ok).toBe(false);
      if (ar.ok) throw new Error("archive unexpectedly succeeded");
      expect(ar.error.code).toBe("ARCHIVE_FAILED");

      const row = resumeSessionById(db, sessionId);
      expect(row?.state).toBe("active");
    } finally {
      conn.close();
      await handle.close();
      db.close();
    }
  });
});

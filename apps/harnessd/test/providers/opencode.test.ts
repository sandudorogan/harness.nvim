import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, FrameDecoder } from "../../src/protocol/encode.ts";
import type { ClientResponse } from "../../src/protocol/types.ts";
import { isDaemonEvent, isResponse } from "../../src/protocol/types.ts";
import {
  classifyOpenCodeFailure,
  type LineTransport,
  OpenCodeJsonRpcSession,
} from "../../src/providers/opencode/adapter.ts";
import { startHarnessServer } from "../../src/server.ts";
import { openDatabase } from "../../src/store/db.ts";
import { getDiffProposal, resumeSessionById } from "../../src/store/sessions.ts";

const tmpRoot = mkdtempSync(join(tmpdir(), "harnessd-opencode-"));

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

/** Scripted OpenCode ACP server over in-memory lines (JSONL). */
function createMockOpenCodeLineTransport(
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

describe("OpenCode provider (unit)", () => {
  test("OpenCodeJsonRpcSession rejects pending requests on EOF", async () => {
    const transport: LineTransport = {
      writeLine() {},
      readLine: () => Promise.resolve(""),
      close: async () => {},
    };

    const rpc = new OpenCodeJsonRpcSession(transport);
    const request = rpc.request("initialize", {});

    await expect(request).rejects.toThrow();
    await rpc.close();
  });

  test("classifyOpenCodeFailure maps auth-like errors to OPENCODE_AUTH_REQUIRED", () => {
    expect(classifyOpenCodeFailure(new Error("401 unauthorized"))).toEqual({
      code: "OPENCODE_AUTH_REQUIRED",
      message: expect.stringContaining("authenticate"),
    });
  });

  test("classifyOpenCodeFailure maps ENOENT to OPENCODE_CLI_NOT_FOUND", () => {
    const err = Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" });
    expect(classifyOpenCodeFailure(err).code).toBe("OPENCODE_CLI_NOT_FOUND");
  });
});

describe("OpenCode provider over harnessd TCP (mocked stdio)", () => {
  test("session.create succeeds and persists OpenCode session id", async () => {
    const stateDir = join(tmpRoot, "o1");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "harness.db");
    const db = openDatabase(dbPath);
    const token = "tok-o1";
    const acpSessionId = "acp_sess_1";

    const handle = await startHarnessServer({
      stateDir,
      db,
      token,
      port: 0,
      opencodeLineTransportFactory: () =>
        createMockOpenCodeLineTransport(async ({ nextClientJson, reply }) => {
          let m = await nextClientJson();
          expect(m.method).toBe("initialize");
          reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "1" } });
          m = await nextClientJson();
          expect(m.method).toBe("session/new");
          expect((m.params as { cwd?: string }).cwd).toBe("/tmp/ws-opencode");
          reply({
            jsonrpc: "2.0",
            id: m.id,
            result: { session: { id: acpSessionId } },
          });
        }),
    });

    const conn = await connectHarness(handle.port, token);
    try {
      conn.send({ id: "h1", method: "daemon.hello", params: { token } });
      expect((await expectResponse(conn, "h1")).ok).toBe(true);

      const { response, prelude } = await exchange(conn, {
        id: "c1",
        method: "session.create",
        params: { workspaceRoot: "/tmp/ws-opencode", provider: "opencode", metadata: {} },
      });

      expect(response.ok).toBe(true);
      if (!response.ok) throw new Error("create failed");
      const sessionId = (response.result as { sessionId: string }).sessionId;
      expect(sessionId.length).toBeGreaterThan(0);

      const row = resumeSessionById(db, sessionId);
      expect(row).not.toBeNull();
      expect(row!.provider).toBe("opencode");
      expect(row!.providerSessionId).toBe(acpSessionId);
      const meta = row!.metadata.opencode as Record<string, unknown> | undefined;
      expect(meta?.sessionId).toBe(acpSessionId);

      const created = prelude.filter((x) => isDaemonEvent(x) && x.event === "session.created");
      expect(created.length).toBe(1);
    } finally {
      conn.close();
      await handle.close();
      db.close();
    }
  });

  test("session.prompt streams message.delta then message.completed", async () => {
    const stateDir = join(tmpRoot, "o2");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "harness.db");
    const db = openDatabase(dbPath);
    const token = "tok-o2";
    const acpSessionId = "acp_sess_2";

    const handle = await startHarnessServer({
      stateDir,
      db,
      token,
      port: 0,
      opencodeLineTransportFactory: () =>
        createMockOpenCodeLineTransport(async ({ nextClientJson, reply }) => {
          let m = await nextClientJson();
          reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "1" } });
          m = await nextClientJson();
          reply({
            jsonrpc: "2.0",
            id: m.id,
            result: { session: { id: acpSessionId } },
          });

          m = await nextClientJson();
          expect(m.method).toBe("session/prompt");
          reply({ jsonrpc: "2.0", id: m.id, result: {} });

          reply({
            method: "session/update",
            params: {
              sessionId: acpSessionId,
              update: { sessionUpdate: "assistant_delta", delta: "hello " },
            },
          });
          reply({
            method: "session/update",
            params: {
              sessionId: acpSessionId,
              update: { sessionUpdate: "assistant_delta", delta: "world" },
            },
          });
          reply({
            method: "session/update",
            params: {
              sessionId: acpSessionId,
              update: { sessionUpdate: "completed" },
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
        params: { workspaceRoot: "/w", provider: "opencode", metadata: {} },
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
          const prov = m.payload.provider as Record<string, unknown> | undefined;
          expect(prov?.opencode).toBeDefined();
          const op = prov?.opencode as Record<string, unknown>;
          expect(op.method).toBe("session/update");
        } else if (isDaemonEvent(m) && m.event === "message.completed") {
          expect(m.payload.turnId).toBe(harnessTurnId);
          const prov = m.payload.provider as Record<string, unknown> | undefined;
          expect((prov?.opencode as Record<string, unknown>)?.method).toBe("session/update");
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

  test("session.request_permission maps to approval.requested with ACP method in metadata", async () => {
    const stateDir = join(tmpRoot, "o3");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "harness.db");
    const db = openDatabase(dbPath);
    const token = "tok-o3";
    const acpSessionId = "acp_sess_3";
    const permissionRpcId = 42;
    const handle = await startHarnessServer({
      stateDir,
      db,
      token,
      port: 0,
      opencodeLineTransportFactory: () =>
        createMockOpenCodeLineTransport(async ({ nextClientJson, reply }) => {
          let m = await nextClientJson();
          reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "1" } });
          m = await nextClientJson();
          reply({
            jsonrpc: "2.0",
            id: m.id,
            result: { session: { id: acpSessionId } },
          });

          m = await nextClientJson();
          expect(m.method).toBe("session/prompt");
          reply({ jsonrpc: "2.0", id: m.id, result: {} });

          reply({
            jsonrpc: "2.0",
            method: "session/request_permission",
            id: permissionRpcId,
            params: {
              sessionId: acpSessionId,
              options: [
                { optionId: "opt-allow-once", name: "Allow once", kind: "allow_once" },
                { optionId: "opt-reject-once", name: "Reject once", kind: "reject_once" },
              ],
            },
          });

          m = await nextClientJson();
          expect(m.id).toBe(permissionRpcId);
          expect(m.result).toEqual({
            outcome: {
              outcome: "selected",
              optionId: "opt-allow-once",
            },
          });

          reply({
            method: "session/update",
            params: {
              sessionId: acpSessionId,
              update: { sessionUpdate: "completed" },
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
        params: { workspaceRoot: "/w", provider: "opencode", metadata: {} },
      });
      expect(cr.ok).toBe(true);
      if (!cr.ok) throw new Error("create failed");
      const sessionId = (cr.result as { sessionId: string }).sessionId;

      conn.send({
        id: "p1",
        method: "session.prompt",
        params: { sessionId, text: "needs perm" },
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
          const prov = m.payload.provider as Record<string, unknown> | undefined;
          const op = prov?.opencode as Record<string, unknown>;
          expect(op.method).toBe("session/request_permission");
          expect(op.params).toBeDefined();
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
    } finally {
      conn.close();
      await handle.close();
      db.close();
    }
  });

  test("session.request_permission defaults to cancelled when harness resolution cannot map to an ACP option", async () => {
    const stateDir = join(tmpRoot, "o3b");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "harness.db");
    const db = openDatabase(dbPath);
    const token = "tok-o3b";
    const acpSessionId = "acp_sess_3b";
    const permissionRpcId = 43;

    const handle = await startHarnessServer({
      stateDir,
      db,
      token,
      port: 0,
      opencodeLineTransportFactory: () =>
        createMockOpenCodeLineTransport(async ({ nextClientJson, reply }) => {
          let m = await nextClientJson();
          reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "1" } });
          m = await nextClientJson();
          reply({
            jsonrpc: "2.0",
            id: m.id,
            result: { session: { id: acpSessionId } },
          });

          m = await nextClientJson();
          expect(m.method).toBe("session/prompt");
          reply({ jsonrpc: "2.0", id: m.id, result: {} });

          reply({
            jsonrpc: "2.0",
            method: "session/request_permission",
            id: permissionRpcId,
            params: {
              sessionId: acpSessionId,
              options: [{ optionId: "opt-reject-once", name: "Reject once", kind: "reject_once" }],
            },
          });

          m = await nextClientJson();
          expect(m.id).toBe(permissionRpcId);
          expect(m.result).toEqual({
            outcome: {
              outcome: "cancelled",
            },
          });

          reply({
            method: "session/update",
            params: {
              sessionId: acpSessionId,
              update: { sessionUpdate: "completed" },
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
        params: { workspaceRoot: "/w", provider: "opencode", metadata: {} },
      });
      expect(cr.ok).toBe(true);
      if (!cr.ok) throw new Error("create failed");
      const sessionId = (cr.result as { sessionId: string }).sessionId;

      conn.send({
        id: "p1",
        method: "session.prompt",
        params: { sessionId, text: "needs perm" },
      });

      let approvalId: string | null = null;
      const deadline = Date.now() + 15_000;

      while (Date.now() < deadline && approvalId === null) {
        const m = await conn.nextMessage();
        if (isDaemonEvent(m) && m.event === "approval.requested") {
          approvalId = m.payload.approvalId as string;
        }
      }
      expect(approvalId).not.toBeNull();

      const { response: ar } = await exchange(conn, {
        id: "a1",
        method: "approval.resolve",
        params: { approvalId, resolution: { choice: "allow_once" } },
      });
      expect(ar.ok).toBe(true);
    } finally {
      conn.close();
      await handle.close();
      db.close();
    }
  });

  test("session/update tool_call diff maps to diff.ready and stores proposal", async () => {
    const stateDir = join(tmpRoot, "o4");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "harness.db");
    const db = openDatabase(dbPath);
    const token = "tok-o4";
    const acpSessionId = "acp_sess_4";

    const handle = await startHarnessServer({
      stateDir,
      db,
      token,
      port: 0,
      opencodeLineTransportFactory: () =>
        createMockOpenCodeLineTransport(async ({ nextClientJson, reply }) => {
          let m = await nextClientJson();
          reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "1" } });
          m = await nextClientJson();
          reply({
            jsonrpc: "2.0",
            id: m.id,
            result: { session: { id: acpSessionId } },
          });

          m = await nextClientJson();
          reply({ jsonrpc: "2.0", id: m.id, result: {} });

          reply({
            method: "session/update",
            params: {
              sessionId: acpSessionId,
              update: {
                sessionUpdate: "tool_call",
                content: [
                  {
                    type: "diff",
                    path: "src/x.ts",
                    oldText: "a",
                    newText: "b",
                  },
                ],
              },
            },
          });
          reply({
            method: "session/update",
            params: {
              sessionId: acpSessionId,
              update: { sessionUpdate: "completed" },
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
        params: { workspaceRoot: "/w", provider: "opencode", metadata: {} },
      });
      expect(cr.ok).toBe(true);
      if (!cr.ok) throw new Error("create failed");
      const sessionId = (cr.result as { sessionId: string }).sessionId;

      conn.send({
        id: "p1",
        method: "session.prompt",
        params: { sessionId, text: "edit" },
      });

      let diffId: string | null = null;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && diffId === null) {
        const m = await conn.nextMessage();
        if (isDaemonEvent(m) && m.event === "diff.ready") {
          diffId = m.payload.diffId as string;
          const prov = m.payload.provider as Record<string, unknown> | undefined;
          expect((prov?.opencode as Record<string, unknown>)?.method).toBe("session/update");
        }
      }
      expect(diffId).not.toBeNull();

      const proposal = getDiffProposal(db, diffId!);
      expect(proposal).not.toBeNull();
      expect(proposal!.path).toBe("src/x.ts");
      expect(proposal!.proposal.proposedContent).toBe("b");
      expect(proposal!.proposal.originalContentHash).toBeDefined();
    } finally {
      conn.close();
      await handle.close();
      db.close();
    }
  });

  test("session.resume uses session/load and records resume metadata", async () => {
    const stateDir = join(tmpRoot, "o5");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "harness.db");
    const db = openDatabase(dbPath);
    const token = "tok-o5";
    const acpSessionId = "acp_persist_5";

    let persistedSessionId = "";

    const handle = await startHarnessServer({
      stateDir,
      db,
      token,
      port: 0,
      opencodeLineTransportFactory: () =>
        createMockOpenCodeLineTransport(async ({ nextClientJson, reply }) => {
          let m = await nextClientJson();
          reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "1" } });
          m = await nextClientJson();
          reply({
            jsonrpc: "2.0",
            id: m.id,
            result: { session: { id: acpSessionId } },
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
        params: { workspaceRoot: "/w", provider: "opencode", metadata: { x: 1 } },
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
      opencodeLineTransportFactory: () =>
        createMockOpenCodeLineTransport(async ({ nextClientJson, reply }) => {
          let m = await nextClientJson();
          reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "1" } });
          m = await nextClientJson();
          expect(m.method).toBe("session/load");
          expect((m.params as { sessionId?: string }).sessionId).toBe(acpSessionId);
          expect((m.params as { cwd?: string }).cwd).toBe("/w");
          reply({ jsonrpc: "2.0", id: m.id, result: { session: { id: acpSessionId } } });
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
      if (!rr.ok) throw new Error("resume failed");
      const row = resumeSessionById(db2, persistedSessionId);
      const op = row?.metadata.opencode as Record<string, unknown> | undefined;
      expect(op?.sessionId).toBe(acpSessionId);
      expect(typeof op?.resumedAt).toBe("number");
    } finally {
      conn2.close();
      await handle2.close();
      db2.close();
    }
  });
});

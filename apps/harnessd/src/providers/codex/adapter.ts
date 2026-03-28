import type { Database } from "bun:sqlite";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { DaemonEvent } from "../../protocol/types.ts";
import { getApproval, insertApproval, updateSessionProviderBinding } from "../../store/sessions.ts";
import type { LineTransport, PromptTurnContext, ProviderAdapter } from "../base.ts";

export type { LineTransport };

type RpcWire = Record<string, unknown>;

function idKey(id: unknown): string {
  return typeof id === "string" ? id : String(id);
}

export class CodexJsonRpcSession {
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private nextId = 1;
  private closed = false;
  private pumpPromise: Promise<void>;
  private serverRequestHandler: ((msg: RpcWire) => Promise<unknown>) | undefined;
  private notificationHandler: ((msg: RpcWire) => void) | undefined;

  constructor(private readonly transport: LineTransport) {
    this.pumpPromise = this.pump();
  }

  setNotificationHandler(handler: (msg: RpcWire) => void): void {
    this.notificationHandler = handler;
  }

  setServerRequestHandler(handler: (msg: RpcWire) => Promise<unknown>): void {
    this.serverRequestHandler = handler;
  }

  async handshake(): Promise<void> {
    const initResult = await this.request("initialize", {
      clientInfo: {
        name: "nvim_harness",
        title: "nvim-harness",
        version: "0.1.0",
      },
    });
    if (initResult === null || typeof initResult !== "object") {
      throw new CodexHandshakeError("initialize returned empty result");
    }
    this.notify("initialized", {});
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    const msg: RpcWire = { method, params };
    this.transport.writeLine(`${JSON.stringify(msg)}\n`);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw new Error("codex rpc closed");
    const id = this.nextId++;
    const key = idKey(id);
    const p = new Promise<unknown>((resolve, reject) => {
      this.pending.set(key, { resolve, reject });
    });
    const msg: RpcWire = { method, id, params };
    this.transport.writeLine(`${JSON.stringify(msg)}\n`);
    return p;
  }

  replyToServerRequest(id: unknown, result: unknown): void {
    if (this.closed) return;
    const msg: RpcWire = { id, result };
    this.transport.writeLine(`${JSON.stringify(msg)}\n`);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const { reject } of this.pending.values()) {
      reject(new Error("codex rpc closed"));
    }
    this.pending.clear();
    await this.transport.close();
    await this.pumpPromise.catch(() => {});
  }

  private async pump(): Promise<void> {
    try {
      while (!this.closed) {
        const line = await this.transport.readLine();
        if (this.closed) break;
        if (line.length === 0) {
          throw new Error("codex rpc EOF");
        }
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let msg: RpcWire;
        try {
          msg = JSON.parse(trimmed) as RpcWire;
        } catch {
          continue;
        }

        const hasMethod = typeof msg.method === "string";
        const hasId = "id" in msg && msg.id !== undefined && msg.id !== null;
        const isResult = "result" in msg || "error" in msg;

        if (hasMethod && hasId && !isResult) {
          const handler = this.serverRequestHandler;
          void (async () => {
            try {
              const res = handler ? await handler(msg) : {};
              this.replyToServerRequest(msg.id, res);
            } catch (e) {
              this.replyToServerRequest(msg.id, { harnessError: String(e) });
            }
          })();
          continue;
        }

        if (hasId && isResult) {
          const key = idKey(msg.id);
          const slot = this.pending.get(key);
          if (!slot) continue;
          this.pending.delete(key);
          if ("error" in msg && msg.error !== undefined) {
            slot.reject(new CodexRpcError(msg.error));
          } else {
            slot.resolve(msg.result);
          }
          continue;
        }

        if (hasMethod) {
          this.notificationHandler?.(msg);
        }
      }
    } catch (e) {
      if (!this.closed) {
        for (const { reject } of this.pending.values()) {
          reject(e);
        }
        this.pending.clear();
      }
    }
  }
}

export class CodexRpcError extends Error {
  readonly raw: unknown;
  constructor(raw: unknown) {
    const o = raw as Record<string, unknown> | null;
    const msg = typeof o?.message === "string" ? o.message : JSON.stringify(raw);
    super(msg);
    this.name = "CodexRpcError";
    this.raw = raw;
  }
}

export class CodexHandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexHandshakeError";
  }
}

export function classifyCodexFailure(e: unknown): { code: string; message: string } {
  if (
    e !== null &&
    typeof e === "object" &&
    "code" in e &&
    (e as NodeJS.ErrnoException).code === "ENOENT"
  ) {
    return {
      code: "CODEX_CLI_NOT_FOUND",
      message: "Codex CLI was not found on PATH. Install the Codex CLI, then try again.",
    };
  }
  const msg = e instanceof Error ? e.message : String(e);
  const low = msg.toLowerCase();
  if (
    low.includes("auth") ||
    low.includes("login") ||
    low.includes("unauthorized") ||
    low.includes("not authenticated") ||
    low.includes("401")
  ) {
    return {
      code: "CODEX_AUTH_REQUIRED",
      message:
        "Codex is not authenticated. Open a regular terminal, run `codex` and complete sign-in (or your usual Codex auth flow), then retry from Neovim.",
    };
  }
  return {
    code: "CODEX_SETUP_FAILED",
    message: msg,
  };
}

export function spawnCodexAppServerTransport(workspaceRoot: string): LineTransport {
  let proc: ChildProcess;
  try {
    proc = spawn("codex", ["app-server"], {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
  } catch (e) {
    throw new CodexSpawnError(e);
  }

  if (!proc.stdin || !proc.stdout) {
    proc.kill();
    throw new Error("codex app-server missing stdio pipes");
  }

  const stdin = proc.stdin;
  const stdout = proc.stdout;
  proc.stderr?.resume();

  const readWaiters: Array<(line: string) => void> = [];
  const lineQueue: string[] = [];
  let buf = "";
  let transportClosed = false;

  const pushLine = (line: string) => {
    const w = readWaiters.shift();
    if (w) w(line);
    else lineQueue.push(line);
  };

  const drainReadWaiters = () => {
    for (const w of readWaiters.splice(0)) {
      w("");
    }
  };

  stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      pushLine(line);
      idx = buf.indexOf("\n");
    }
  });

  stdout.on("close", () => {
    transportClosed = true;
    if (buf.length > 0) pushLine(buf);
    buf = "";
    drainReadWaiters();
  });

  let closed = false;

  return {
    writeLine(line: string) {
      if (closed) return;
      const payload = line.endsWith("\n") ? line : `${line}\n`;
      stdin.write(payload, (err) => {
        if (err && !closed) proc.kill();
      });
    },
    readLine(): Promise<string> {
      if (closed || transportClosed) return Promise.resolve("");
      const q = lineQueue.shift();
      if (q !== undefined) return Promise.resolve(q);
      return new Promise((resolve) => {
        readWaiters.push(resolve);
      });
    },
    close: async () => {
      closed = true;
      transportClosed = true;
      drainReadWaiters();
      stdin.end();
      proc.kill();
      await new Promise<void>((r) => proc.once("exit", () => r()));
    },
  };
}

export class CodexSpawnError extends Error {
  readonly causeUnknown: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "CodexSpawnError";
    this.causeUnknown = cause;
  }
}

function mergeCodexMetadata(
  base: Record<string, unknown>,
  codexPatch: Record<string, unknown>,
): Record<string, unknown> {
  const prev = (base.codex as Record<string, unknown>) ?? {};
  return { ...base, codex: { ...prev, ...codexPatch } };
}

export async function bootstrapCodexNewThread(
  transport: LineTransport,
  input: {
    db: Database;
    harnessSessionId: string;
    workspaceRoot: string;
    metadata: Record<string, unknown>;
  },
): Promise<{ rpc: CodexJsonRpcSession; threadId: string; metadata: Record<string, unknown> }> {
  const rpc = new CodexJsonRpcSession(transport);
  try {
    await rpc.handshake();
  } catch (e) {
    await rpc.close().catch(() => {});
    if (e instanceof CodexRpcError) {
      const c = classifyCodexFailure(e);
      throw Object.assign(new Error(c.message), { code: c.code, detail: e.raw });
    }
    throw e;
  }

  const model =
    typeof input.metadata.model === "string" && input.metadata.model.length > 0
      ? input.metadata.model
      : "gpt-5.4";

  let threadResult: unknown;
  try {
    threadResult = await rpc.request("thread/start", {
      model,
      cwd: input.workspaceRoot,
      approvalPolicy: "unlessTrusted",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [input.workspaceRoot],
        networkAccess: false,
      },
      serviceName: "nvim_harness",
    });
  } catch (e) {
    await rpc.close().catch(() => {});
    if (e instanceof CodexRpcError) {
      const c = classifyCodexFailure(e);
      throw Object.assign(new Error(c.message), { code: c.code, detail: e.raw });
    }
    throw e;
  }

  const tr = threadResult as { thread?: { id?: string } };
  const threadId = tr.thread?.id;
  if (typeof threadId !== "string" || threadId.length === 0) {
    await rpc.close().catch(() => {});
    throw new Error("thread/start missing thread.id");
  }

  const meta = mergeCodexMetadata(input.metadata, { threadId, model });
  updateSessionProviderBinding(input.db, input.harnessSessionId, {
    providerSessionId: threadId,
    metadata: meta,
  });

  return { rpc, threadId, metadata: meta };
}

export async function bootstrapCodexResumeThread(
  transport: LineTransport,
  input: {
    db: Database;
    harnessSessionId: string;
    workspaceRoot: string;
    threadId: string;
    metadata: Record<string, unknown>;
  },
): Promise<{ rpc: CodexJsonRpcSession; metadata: Record<string, unknown> }> {
  const rpc = new CodexJsonRpcSession(transport);
  try {
    await rpc.handshake();
  } catch (e) {
    await rpc.close().catch(() => {});
    if (e instanceof CodexRpcError) {
      const c = classifyCodexFailure(e);
      throw Object.assign(new Error(c.message), { code: c.code, detail: e.raw });
    }
    throw e;
  }

  try {
    await rpc.request("thread/resume", {
      threadId: input.threadId,
      cwd: input.workspaceRoot,
    });
  } catch (e) {
    await rpc.close().catch(() => {});
    if (e instanceof CodexRpcError) {
      const c = classifyCodexFailure(e);
      throw Object.assign(new Error(c.message), { code: c.code, detail: e.raw });
    }
    throw e;
  }

  const meta = mergeCodexMetadata(input.metadata, { resumedAt: Date.now() });
  updateSessionProviderBinding(input.db, input.harnessSessionId, {
    providerSessionId: input.threadId,
    metadata: meta,
  });

  return { rpc, metadata: meta };
}

function approvalLikeMethod(method: string): boolean {
  return /approval|elicitation|permission|userinput|requestuserinput/i.test(method);
}

export class CodexProviderAdapter implements ProviderAdapter {
  readonly providerId = "codex";
  private readonly approvalContinuations = new Map<string, { finish: (result: unknown) => void }>();
  private activeDb: Database | null = null;
  private activeEmit: ((ev: DaemonEvent) => void) | null = null;
  private currentCodexTurnId: string | null = null;
  private currentHarnessTurnId: string | null = null;
  private pendingTurnDone: (() => void) | null = null;

  constructor(
    private readonly rpc: CodexJsonRpcSession,
    private readonly opts: {
      harnessSessionId: string;
      threadId: string;
      workspaceRoot: string;
      model: string;
    },
  ) {
    this.rpc.setServerRequestHandler((msg) => this.onCodexServerRequest(msg));
    this.rpc.setNotificationHandler((msg) => this.onCodexNotification(msg));
  }

  notifyApprovalResolved(approvalId: string): void {
    const c = this.approvalContinuations.get(approvalId);
    if (!c) return;
    this.approvalContinuations.delete(approvalId);
    const db = this.activeDb;
    if (!db) {
      c.finish({ acknowledged: true });
      return;
    }
    const row = getApproval(db, approvalId);
    c.finish(row?.resolution ?? { acknowledged: true });
  }

  async archiveSession(): Promise<void> {
    let archiveError: unknown = null;
    try {
      await this.rpc.request("thread/archive", { threadId: this.opts.threadId });
    } catch (e) {
      archiveError = e;
    }
    try {
      await this.rpc.close();
    } catch (e) {
      if (archiveError === null) throw e;
    }
    if (archiveError !== null) throw archiveError;
  }

  private async onCodexServerRequest(msg: RpcWire): Promise<unknown> {
    const method = typeof msg.method === "string" ? msg.method : "";
    if (!approvalLikeMethod(method)) {
      return { skipped: true, method };
    }
    const db = this.activeDb;
    const emit = this.activeEmit;
    if (!db || !emit) {
      return { error: "no active turn" };
    }
    const turnId = this.currentHarnessTurnId;
    if (typeof turnId !== "string") {
      return { error: "no harness turn" };
    }

    const approvalId = randomUUID();
    insertApproval(db, {
      id: approvalId,
      sessionId: this.opts.harnessSessionId,
      turnId,
      state: "pending",
      request: { method, params: msg.params },
    });

    emit({
      event: "approval.requested",
      sessionId: this.opts.harnessSessionId,
      timestamp: Date.now(),
      payload: {
        turnId,
        approvalId,
        tool: method,
        provider: { codex: msg },
      },
    });

    return await new Promise<unknown>((resolve) => {
      this.approvalContinuations.set(approvalId, { finish: resolve });
    });
  }

  private onCodexNotification(msg: RpcWire): void {
    const emit = this.activeEmit;
    if (!emit) return;

    const method = typeof msg.method === "string" ? msg.method : "";
    const params = (msg.params ?? {}) as Record<string, unknown>;

    if (method === "item/agentMessage/delta") {
      const tid = params.turnId;
      if (
        typeof tid === "string" &&
        this.currentCodexTurnId !== null &&
        tid !== this.currentCodexTurnId
      ) {
        return;
      }
      const delta = params.delta;
      const text = typeof delta === "string" ? delta : "";
      if (text.length === 0) return;
      const harnessTurn = this.currentHarnessTurnId;
      if (typeof harnessTurn !== "string") return;
      emit({
        event: "message.delta",
        sessionId: this.opts.harnessSessionId,
        timestamp: Date.now(),
        payload: {
          turnId: harnessTurn,
          text,
          provider: { codex: msg },
        },
      });
      return;
    }

    if (method === "turn/completed") {
      const turn = params.turn as Record<string, unknown> | undefined;
      const tid = turn && typeof turn.id === "string" ? turn.id : undefined;
      if (
        tid !== undefined &&
        this.currentCodexTurnId !== null &&
        tid !== this.currentCodexTurnId
      ) {
        return;
      }
      const harnessTurn = this.currentHarnessTurnId;
      if (typeof harnessTurn === "string") {
        emit({
          event: "message.completed",
          sessionId: this.opts.harnessSessionId,
          timestamp: Date.now(),
          payload: {
            turnId: harnessTurn,
            provider: { codex: msg },
          },
        });
      }
      const done = this.pendingTurnDone;
      this.pendingTurnDone = null;
      done?.();
      return;
    }
  }

  async onPromptTurn(ctx: PromptTurnContext): Promise<void> {
    const { sessionId, turnId, text, db, emit } = ctx;
    this.activeDb = db;
    this.activeEmit = emit;
    this.currentHarnessTurnId = turnId;
    this.currentCodexTurnId = null;

    const turnDone = new Promise<void>((resolve) => {
      this.pendingTurnDone = resolve;
    });

    try {
      const startRes = (await this.rpc.request("turn/start", {
        threadId: this.opts.threadId,
        input: [{ type: "text", text }],
        cwd: this.opts.workspaceRoot,
        model: this.opts.model,
      })) as { turn?: { id?: string } };

      const cid = startRes.turn?.id;
      if (typeof cid !== "string") {
        throw new Error("turn/start missing turn.id");
      }
      this.currentCodexTurnId = cid;

      await turnDone;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emit({
        event: "session.failed",
        sessionId,
        timestamp: Date.now(),
        payload: { turnId, message: msg, provider: { codex: e } },
      });
    } finally {
      this.pendingTurnDone = null;
      this.currentCodexTurnId = null;
      this.currentHarnessTurnId = null;
      this.activeDb = null;
      this.activeEmit = null;
    }
  }
}

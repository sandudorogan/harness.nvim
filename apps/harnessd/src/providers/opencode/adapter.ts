import type { Database } from "bun:sqlite";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hashContentUtf8, insertDiffProposal } from "../../diff/proposals.ts";
import type { DaemonEvent } from "../../protocol/types.ts";
import { getApproval, insertApproval, updateSessionProviderBinding } from "../../store/sessions.ts";
import type { LineTransport, PromptTurnContext, ProviderAdapter } from "../base.ts";

export type { LineTransport };

type RpcWire = Record<string, unknown>;

function idKey(id: unknown): string {
  return typeof id === "string" ? id : String(id);
}

export class OpenCodeJsonRpcSession {
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
      throw new OpenCodeHandshakeError("initialize returned empty result");
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw new Error("opencode rpc closed");
    const id = this.nextId++;
    const key = idKey(id);
    const p = new Promise<unknown>((resolve, reject) => {
      this.pending.set(key, { resolve, reject });
    });
    const msg: RpcWire = { jsonrpc: "2.0", method, id, params };
    this.transport.writeLine(`${JSON.stringify(msg)}\n`);
    return p;
  }

  replyToServerRequest(id: unknown, result: unknown): void {
    if (this.closed) return;
    const msg: RpcWire = { jsonrpc: "2.0", id, result };
    this.transport.writeLine(`${JSON.stringify(msg)}\n`);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const { reject } of this.pending.values()) {
      reject(new Error("opencode rpc closed"));
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
          throw new Error("opencode rpc EOF");
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
            slot.reject(new OpenCodeRpcError(msg.error));
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

export class OpenCodeRpcError extends Error {
  readonly raw: unknown;
  constructor(raw: unknown) {
    const o = raw as Record<string, unknown> | null;
    const msg = typeof o?.message === "string" ? o.message : JSON.stringify(raw);
    super(msg);
    this.name = "OpenCodeRpcError";
    this.raw = raw;
  }
}

export class OpenCodeHandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeHandshakeError";
  }
}

export class OpenCodeSpawnError extends Error {
  readonly causeUnknown: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "OpenCodeSpawnError";
    this.causeUnknown = cause;
  }
}

export function classifyOpenCodeFailure(e: unknown): { code: string; message: string } {
  if (
    e !== null &&
    typeof e === "object" &&
    "code" in e &&
    (e as NodeJS.ErrnoException).code === "ENOENT"
  ) {
    return {
      code: "OPENCODE_CLI_NOT_FOUND",
      message: "OpenCode CLI was not found on PATH. Install OpenCode, then try again.",
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
      code: "OPENCODE_AUTH_REQUIRED",
      message:
        "OpenCode is not authenticated. Open a regular terminal, run `opencode` and complete sign-in (or your usual OpenCode auth flow), then retry from Neovim.",
    };
  }
  return {
    code: "OPENCODE_SETUP_FAILED",
    message: msg,
  };
}

export function spawnOpenCodeAcpTransport(workspaceRoot: string): LineTransport {
  let proc: ChildProcess;
  try {
    proc = spawn("opencode", ["acp"], {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
  } catch (e) {
    throw new OpenCodeSpawnError(e);
  }

  if (!proc.stdin || !proc.stdout) {
    proc.kill();
    throw new Error("opencode acp missing stdio pipes");
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

function mergeOpenCodeMetadata(
  base: Record<string, unknown>,
  opencodePatch: Record<string, unknown>,
): Record<string, unknown> {
  const prev = (base.opencode as Record<string, unknown>) ?? {};
  return { ...base, opencode: { ...prev, ...opencodePatch } };
}

function extractAcpSessionId(result: unknown): string | null {
  if (result === null || typeof result !== "object") return null;
  const o = result as Record<string, unknown>;
  const sess = o.session;
  if (sess !== null && typeof sess === "object") {
    const id = (sess as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  const sid = o.sessionId;
  if (typeof sid === "string" && sid.length > 0) return sid;
  return null;
}

type AcpPermissionOption = {
  optionId: string;
  kind: string;
};

export async function bootstrapOpenCodeNewSession(
  transport: LineTransport,
  input: {
    db: Database;
    harnessSessionId: string;
    workspaceRoot: string;
    metadata: Record<string, unknown>;
  },
): Promise<{
  rpc: OpenCodeJsonRpcSession;
  acpSessionId: string;
  metadata: Record<string, unknown>;
}> {
  const rpc = new OpenCodeJsonRpcSession(transport);
  try {
    await rpc.handshake();
  } catch (e) {
    await rpc.close().catch(() => {});
    if (e instanceof OpenCodeRpcError) {
      const c = classifyOpenCodeFailure(e);
      throw Object.assign(new Error(c.message), { code: c.code, detail: e.raw });
    }
    throw e;
  }

  let sessionResult: unknown;
  try {
    sessionResult = await rpc.request("session/new", {
      cwd: input.workspaceRoot,
    });
  } catch (e) {
    await rpc.close().catch(() => {});
    if (e instanceof OpenCodeRpcError) {
      const c = classifyOpenCodeFailure(e);
      throw Object.assign(new Error(c.message), { code: c.code, detail: e.raw });
    }
    throw e;
  }

  const acpSessionId = extractAcpSessionId(sessionResult);
  if (acpSessionId === null) {
    await rpc.close().catch(() => {});
    throw new Error("session/new missing session id");
  }

  const meta = mergeOpenCodeMetadata(input.metadata, { sessionId: acpSessionId });
  updateSessionProviderBinding(input.db, input.harnessSessionId, {
    providerSessionId: acpSessionId,
    metadata: meta,
  });

  return { rpc, acpSessionId, metadata: meta };
}

export async function bootstrapOpenCodeLoadSession(
  transport: LineTransport,
  input: {
    db: Database;
    harnessSessionId: string;
    workspaceRoot: string;
    acpSessionId: string;
    metadata: Record<string, unknown>;
  },
): Promise<{ rpc: OpenCodeJsonRpcSession; metadata: Record<string, unknown> }> {
  const rpc = new OpenCodeJsonRpcSession(transport);
  try {
    await rpc.handshake();
  } catch (e) {
    await rpc.close().catch(() => {});
    if (e instanceof OpenCodeRpcError) {
      const c = classifyOpenCodeFailure(e);
      throw Object.assign(new Error(c.message), { code: c.code, detail: e.raw });
    }
    throw e;
  }

  try {
    await rpc.request("session/load", {
      sessionId: input.acpSessionId,
      cwd: input.workspaceRoot,
    });
  } catch (e) {
    await rpc.close().catch(() => {});
    if (e instanceof OpenCodeRpcError) {
      const c = classifyOpenCodeFailure(e);
      throw Object.assign(new Error(c.message), { code: c.code, detail: e.raw });
    }
    throw e;
  }

  const meta = mergeOpenCodeMetadata(input.metadata, { resumedAt: Date.now() });
  updateSessionProviderBinding(input.db, input.harnessSessionId, {
    providerSessionId: input.acpSessionId,
    metadata: meta,
  });

  return { rpc, metadata: meta };
}

function extractAcpPermissionOptions(params: unknown): AcpPermissionOption[] {
  if (params === null || typeof params !== "object") return [];
  const options = (params as { options?: unknown }).options;
  if (!Array.isArray(options)) return [];

  const out: AcpPermissionOption[] = [];
  for (const option of options) {
    if (option === null || typeof option !== "object") continue;
    const o = option as { optionId?: unknown; kind?: unknown };
    if (typeof o.optionId !== "string" || o.optionId.length === 0) continue;
    if (typeof o.kind !== "string" || o.kind.length === 0) continue;
    out.push({ optionId: o.optionId, kind: o.kind });
  }
  return out;
}

function cancelledAcpPermissionResult(): Record<string, unknown> {
  return { outcome: { outcome: "cancelled" } };
}

function mapHarnessResolutionToAcpPermission(
  resolution: unknown,
  options: AcpPermissionOption[],
): Record<string, unknown> {
  if (resolution !== null && typeof resolution === "object" && "optionId" in resolution) {
    const optionId = (resolution as { optionId?: unknown }).optionId;
    if (typeof optionId === "string" && options.some((option) => option.optionId === optionId)) {
      return { outcome: { outcome: "selected", optionId } };
    }
  }

  let requestedKind: string | null = null;
  if (resolution !== null && typeof resolution === "object" && "choice" in resolution) {
    const choice = (resolution as { choice?: unknown }).choice;
    if (typeof choice === "string" && choice.length > 0) requestedKind = choice;
  }
  if (
    requestedKind === null &&
    resolution !== null &&
    typeof resolution === "object" &&
    "kind" in resolution
  ) {
    const kind = (resolution as { kind?: unknown }).kind;
    if (typeof kind === "string" && kind.length > 0) requestedKind = kind;
  }

  if (requestedKind === null) return cancelledAcpPermissionResult();

  const selected = options.find((option) => option.kind === requestedKind);
  if (!selected) return cancelledAcpPermissionResult();

  return {
    outcome: {
      outcome: "selected",
      optionId: selected.optionId,
    },
  };
}

function collectDiffEntries(update: Record<string, unknown>): Array<{
  path: string;
  oldText: string;
  newText: string;
}> {
  const out: Array<{ path: string; oldText: string; newText: string }> = [];
  const scan = (v: unknown) => {
    if (!Array.isArray(v)) return;
    for (const entry of v) {
      if (entry === null || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (e.type !== "diff") continue;
      const path = e.path;
      const oldText = e.oldText;
      const newText = e.newText;
      if (typeof path !== "string" || typeof oldText !== "string" || typeof newText !== "string")
        continue;
      out.push({ path, oldText, newText });
    }
  };
  scan(update.content);
  const nested = update.toolCall;
  if (nested !== null && typeof nested === "object") {
    scan((nested as Record<string, unknown>).content);
  }
  return out;
}

export class OpenCodeProviderAdapter implements ProviderAdapter {
  readonly providerId = "opencode";
  private readonly approvalContinuations = new Map<
    string,
    { finish: (result: unknown) => void; options: AcpPermissionOption[] }
  >();
  private activeDb: Database | null = null;
  private activeEmit: ((ev: DaemonEvent) => void) | null = null;
  private currentHarnessTurnId: string | null = null;
  private pendingTurnDone: (() => void) | null = null;

  constructor(
    private readonly rpc: OpenCodeJsonRpcSession,
    private readonly opts: {
      harnessSessionId: string;
      opencodeSessionId: string;
      workspaceRoot: string;
    },
  ) {
    this.rpc.setServerRequestHandler((msg) => this.onAcpServerRequest(msg));
    this.rpc.setNotificationHandler((msg) => this.onAcpNotification(msg));
  }

  notifyApprovalResolved(approvalId: string): void {
    const c = this.approvalContinuations.get(approvalId);
    if (!c) return;
    this.approvalContinuations.delete(approvalId);
    const db = this.activeDb;
    if (!db) {
      c.finish(cancelledAcpPermissionResult());
      return;
    }
    const row = getApproval(db, approvalId);
    c.finish(mapHarnessResolutionToAcpPermission(row?.resolution, c.options));
  }

  async archiveSession(): Promise<void> {
    await this.rpc.close();
  }

  private async onAcpServerRequest(msg: RpcWire): Promise<unknown> {
    const method = typeof msg.method === "string" ? msg.method : "";
    if (method !== "session/request_permission") {
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
    const options = extractAcpPermissionOptions(msg.params);
    insertApproval(db, {
      id: approvalId,
      sessionId: this.opts.harnessSessionId,
      turnId,
      state: "pending",
      request: { method, params: msg.params },
    });

    const native = {
      jsonrpc: "2.0",
      method,
      id: msg.id,
      params: msg.params,
    };

    emit({
      event: "approval.requested",
      sessionId: this.opts.harnessSessionId,
      timestamp: Date.now(),
      payload: {
        turnId,
        approvalId,
        tool: method,
        provider: { opencode: native },
      },
    });

    return await new Promise<unknown>((resolve) => {
      this.approvalContinuations.set(approvalId, { finish: resolve, options });
    });
  }

  private onAcpNotification(msg: RpcWire): void {
    const emit = this.activeEmit;
    if (!emit) return;

    const method = typeof msg.method === "string" ? msg.method : "";
    if (method !== "session/update") return;

    const params = (msg.params ?? {}) as Record<string, unknown>;
    const sid = params.sessionId;
    if (typeof sid === "string" && sid !== this.opts.opencodeSessionId) {
      return;
    }

    const update = (params.update ?? {}) as Record<string, unknown>;
    const su = update.sessionUpdate;
    const harnessTurn = this.currentHarnessTurnId;
    if (typeof harnessTurn !== "string") return;

    const wrapProvider = () => ({ opencode: { method, params } });

    if (su === "assistant_delta") {
      const delta = update.delta;
      const text = typeof delta === "string" ? delta : "";
      if (text.length === 0) return;
      emit({
        event: "message.delta",
        sessionId: this.opts.harnessSessionId,
        timestamp: Date.now(),
        payload: {
          turnId: harnessTurn,
          text,
          provider: wrapProvider(),
        },
      });
      return;
    }

    if (su === "tool_call" || su === "tool_call_update") {
      const diffs = collectDiffEntries(update);
      const db = this.activeDb;
      for (const d of diffs) {
        const diffId = randomUUID();
        if (db) {
          insertDiffProposal(db, {
            id: diffId,
            sessionId: this.opts.harnessSessionId,
            turnId: harnessTurn,
            path: d.path,
            state: "pending",
            proposedContent: d.newText,
            originalContentHash: hashContentUtf8(d.oldText),
            provider: {
              opencode: {
                method,
                sessionUpdate: su,
                path: d.path,
              },
            },
          });
        }
        emit({
          event: "diff.ready",
          sessionId: this.opts.harnessSessionId,
          timestamp: Date.now(),
          payload: {
            turnId: harnessTurn,
            diffId,
            path: d.path,
            provider: wrapProvider(),
          },
        });
      }
      return;
    }

    if (su === "completed") {
      emit({
        event: "message.completed",
        sessionId: this.opts.harnessSessionId,
        timestamp: Date.now(),
        payload: {
          turnId: harnessTurn,
          provider: wrapProvider(),
        },
      });
      const done = this.pendingTurnDone;
      this.pendingTurnDone = null;
      done?.();
    }
  }

  async onPromptTurn(ctx: PromptTurnContext): Promise<void> {
    const { sessionId, turnId, text, db, emit } = ctx;
    this.activeDb = db;
    this.activeEmit = emit;
    this.currentHarnessTurnId = turnId;

    const turnDone = new Promise<void>((resolve) => {
      this.pendingTurnDone = resolve;
    });

    try {
      await this.rpc.request("session/prompt", {
        sessionId: this.opts.opencodeSessionId,
        text,
        cwd: this.opts.workspaceRoot,
      });

      await turnDone;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emit({
        event: "session.failed",
        sessionId,
        timestamp: Date.now(),
        payload: { turnId, message: msg, provider: { opencode: e } },
      });
    } finally {
      this.pendingTurnDone = null;
      this.currentHarnessTurnId = null;
      this.activeDb = null;
      this.activeEmit = null;
    }
  }
}

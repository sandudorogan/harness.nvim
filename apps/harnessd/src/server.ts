import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { getDiffProposal, hashContentUtf8, updateDiffProposalState } from "./diff/proposals.ts";
import { encodeFrame, FrameDecoder } from "./protocol/encode.ts";
import type { ClientResponse, DaemonEvent } from "./protocol/types.ts";
import { parseClientRequest } from "./protocol/types.ts";
import type { LineTransport, ProviderAdapter } from "./providers/base.ts";
import {
  bootstrapCodexNewThread,
  bootstrapCodexResumeThread,
  CodexProviderAdapter,
  classifyCodexFailure,
  spawnCodexAppServerTransport,
} from "./providers/codex/adapter.ts";
import { FakeProviderAdapter } from "./providers/fake/adapter.ts";
import {
  bootstrapOpenCodeLoadSession,
  bootstrapOpenCodeNewSession,
  classifyOpenCodeFailure,
  OpenCodeProviderAdapter,
  spawnOpenCodeAcpTransport,
} from "./providers/opencode/adapter.ts";
import { appendEvent } from "./store/events.ts";
import {
  deleteSessionById,
  getApproval,
  insertSession,
  listActiveSessions,
  resumeSessionById,
  updateApprovalResolution,
  updateSessionState,
} from "./store/sessions.ts";

export type StartHarnessOptions = {
  stateDir: string;
  db: Database;
  token: string;
  port?: number;
  codexLineTransportFactory?: (opts: { workspaceRoot: string }) => LineTransport;
  opencodeLineTransportFactory?: (opts: { workspaceRoot: string }) => LineTransport;
};

export type HarnessServerHandle = {
  port: number;
  close: () => Promise<void>;
};

type UiSend = (buf: Uint8Array) => void;

type SessionRuntime = {
  provider: string;
  adapter: ProviderAdapter;
  activeTurnId: string | null;
};

export class SessionRegistry {
  private readonly uiClients = new Map<string, UiSend>();
  private readonly sessions = new Map<string, SessionRuntime>();

  addUiClient(id: string, send: UiSend): void {
    this.uiClients.set(id, send);
  }

  removeUiClient(id: string): void {
    this.uiClients.delete(id);
  }

  get connectedUiClientCount(): number {
    return this.uiClients.size;
  }

  registerSession(sessionId: string, runtime: SessionRuntime): void {
    this.sessions.set(sessionId, runtime);
  }

  getSession(sessionId: string): SessionRuntime | undefined {
    return this.sessions.get(sessionId);
  }

  unregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  broadcastFrame(wire: Uint8Array): void {
    for (const send of this.uiClients.values()) {
      send(wire);
    }
  }
}

const fakeAdapter = new FakeProviderAdapter();

function errResponse(
  replyTo: string,
  code: string,
  message: string,
  detail?: unknown,
): ClientResponse {
  return {
    replyTo,
    ok: false,
    error: detail === undefined ? { code, message } : { code, message, detail },
  };
}

function okResponse(replyTo: string, result: unknown): ClientResponse {
  return { replyTo, ok: true, result };
}

export function startHarnessServer(opts: StartHarnessOptions): Promise<HarnessServerHandle> {
  const registry = new SessionRegistry();
  const { db, token, codexLineTransportFactory, opencodeLineTransportFactory } = opts;
  const mkCodexTransport =
    codexLineTransportFactory ??
    ((o: { workspaceRoot: string }) => spawnCodexAppServerTransport(o.workspaceRoot));
  const mkOpenCodeTransport =
    opencodeLineTransportFactory ??
    ((o: { workspaceRoot: string }) => spawnOpenCodeAcpTransport(o.workspaceRoot));
  const sockets = new Set<Socket>();
  const inFlightTurns = new Set<Promise<void>>();
  let closePromise: Promise<void> | null = null;

  const emitForSession = (sessionId: string): ((ev: DaemonEvent) => void) => {
    return (ev: DaemonEvent) => {
      appendEvent(db, sessionId, {
        event: ev.event,
        timestamp: ev.timestamp,
        payload: ev.payload,
      });
      registry.broadcastFrame(encodeFrame(ev));
    };
  };

  const handleLine = async (
    connId: string,
    raw: string,
    authenticated: { value: boolean },
    send: UiSend,
  ): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      send(encodeFrame(errResponse("", "INVALID_JSON", "frame body is not valid JSON")));
      return;
    }

    const pr = parseClientRequest(parsed);
    if (!pr.ok) {
      send(encodeFrame(errResponse(pr.replyTo, pr.error.code, pr.error.message, pr.error.detail)));
      return;
    }

    const req = pr.request;

    if (req.method !== "daemon.hello" && !authenticated.value) {
      send(encodeFrame(errResponse(req.id, "UNAUTHENTICATED", "call daemon.hello first")));
      return;
    }

    if (req.method === "daemon.hello") {
      const params = (req.params ?? {}) as { token?: string };
      if (params.token !== token) {
        send(encodeFrame(errResponse(req.id, "AUTH_FAILED", "invalid token")));
        return;
      }
      authenticated.value = true;
      registry.addUiClient(connId, send);
      send(encodeFrame(okResponse(req.id, { ok: true })));
      return;
    }

    if (req.method === "session.list") {
      const rows = listActiveSessions(db);
      send(
        encodeFrame(
          okResponse(req.id, {
            sessions: rows.map((r) => ({
              id: r.id,
              workspaceRoot: r.workspaceRoot,
              provider: r.provider,
              providerSessionId: r.providerSessionId,
              state: r.state,
              createdAt: r.createdAt,
              updatedAt: r.updatedAt,
            })),
          }),
        ),
      );
      return;
    }

    if (req.method === "session.create") {
      const params = (req.params ?? {}) as {
        workspaceRoot?: string;
        provider?: string;
        metadata?: Record<string, unknown>;
      };
      if (typeof params.workspaceRoot !== "string" || params.workspaceRoot.length === 0) {
        send(encodeFrame(errResponse(req.id, "INVALID_PARAMS", "workspaceRoot required")));
        return;
      }
      if (
        params.provider !== "fake" &&
        params.provider !== "codex" &&
        params.provider !== "opencode"
      ) {
        send(
          encodeFrame(
            errResponse(
              req.id,
              "UNSUPPORTED_PROVIDER",
              "only fake, codex, and opencode providers are available",
              {
                provider: params.provider,
              },
            ),
          ),
        );
        return;
      }

      const sessionId = randomUUID();
      const meta = params.metadata ?? {};
      const wsRoot = params.workspaceRoot;

      if (params.provider === "fake") {
        insertSession(db, {
          id: sessionId,
          workspaceRoot: wsRoot,
          provider: "fake",
          providerSessionId: `fake:${sessionId}`,
          metadata: meta,
        });

        registry.registerSession(sessionId, {
          provider: "fake",
          adapter: fakeAdapter,
          activeTurnId: null,
        });

        const createdFake: DaemonEvent = {
          event: "session.created",
          sessionId,
          timestamp: Date.now(),
          payload: { workspaceRoot: wsRoot, provider: "fake" },
        };
        appendEvent(db, sessionId, {
          event: createdFake.event,
          timestamp: createdFake.timestamp,
          payload: createdFake.payload,
        });
        registry.broadcastFrame(encodeFrame(createdFake));

        send(encodeFrame(okResponse(req.id, { sessionId })));
        return;
      }

      if (params.provider === "codex") {
        insertSession(db, {
          id: sessionId,
          workspaceRoot: wsRoot,
          provider: "codex",
          providerSessionId: null,
          metadata: meta,
        });

        let transport: LineTransport;
        try {
          transport = mkCodexTransport({ workspaceRoot: wsRoot });
        } catch (e: unknown) {
          deleteSessionById(db, sessionId);
          const c = classifyCodexFailure(e);
          send(encodeFrame(errResponse(req.id, c.code, c.message, { cause: String(e) })));
          return;
        }

        let boot: Awaited<ReturnType<typeof bootstrapCodexNewThread>>;
        try {
          boot = await bootstrapCodexNewThread(transport, {
            db,
            harnessSessionId: sessionId,
            workspaceRoot: wsRoot,
            metadata: meta,
          });
        } catch (e: unknown) {
          deleteSessionById(db, sessionId);
          await transport.close().catch(() => {});
          const rec = e as { code?: string; message?: string };
          const code =
            typeof rec.code === "string" && rec.code.length > 0 ? rec.code : "CODEX_SETUP_FAILED";
          const message = e instanceof Error ? e.message : String(e);
          send(encodeFrame(errResponse(req.id, code, message, { detail: e })));
          return;
        }

        const codexMeta = boot.metadata.codex as Record<string, unknown> | undefined;
        const model = typeof codexMeta?.model === "string" ? codexMeta.model : "gpt-5.4";
        const adapter = new CodexProviderAdapter(boot.rpc, {
          harnessSessionId: sessionId,
          threadId: boot.threadId,
          workspaceRoot: wsRoot,
          model,
        });

        registry.registerSession(sessionId, {
          provider: "codex",
          adapter,
          activeTurnId: null,
        });

        const createdCodex: DaemonEvent = {
          event: "session.created",
          sessionId,
          timestamp: Date.now(),
          payload: {
            workspaceRoot: wsRoot,
            provider: "codex",
            providerSessionId: boot.threadId,
            metadata: boot.metadata,
          },
        };
        appendEvent(db, sessionId, {
          event: createdCodex.event,
          timestamp: createdCodex.timestamp,
          payload: createdCodex.payload,
        });
        registry.broadcastFrame(encodeFrame(createdCodex));

        send(encodeFrame(okResponse(req.id, { sessionId })));
        return;
      }

      insertSession(db, {
        id: sessionId,
        workspaceRoot: wsRoot,
        provider: "opencode",
        providerSessionId: null,
        metadata: meta,
      });

      let ocTransport: LineTransport;
      try {
        ocTransport = mkOpenCodeTransport({ workspaceRoot: wsRoot });
      } catch (e: unknown) {
        deleteSessionById(db, sessionId);
        const c = classifyOpenCodeFailure(e);
        send(encodeFrame(errResponse(req.id, c.code, c.message, { cause: String(e) })));
        return;
      }

      let ocBoot: Awaited<ReturnType<typeof bootstrapOpenCodeNewSession>>;
      try {
        ocBoot = await bootstrapOpenCodeNewSession(ocTransport, {
          db,
          harnessSessionId: sessionId,
          workspaceRoot: wsRoot,
          metadata: meta,
        });
      } catch (e: unknown) {
        deleteSessionById(db, sessionId);
        await ocTransport.close().catch(() => {});
        const rec = e as { code?: string; message?: string };
        const code =
          typeof rec.code === "string" && rec.code.length > 0 ? rec.code : "OPENCODE_SETUP_FAILED";
        const message = e instanceof Error ? e.message : String(e);
        send(encodeFrame(errResponse(req.id, code, message, { detail: e })));
        return;
      }

      const ocAdapter = new OpenCodeProviderAdapter(ocBoot.rpc, {
        harnessSessionId: sessionId,
        opencodeSessionId: ocBoot.acpSessionId,
        workspaceRoot: wsRoot,
      });

      registry.registerSession(sessionId, {
        provider: "opencode",
        adapter: ocAdapter,
        activeTurnId: null,
      });

      const createdOpenCode: DaemonEvent = {
        event: "session.created",
        sessionId,
        timestamp: Date.now(),
        payload: {
          workspaceRoot: wsRoot,
          provider: "opencode",
          providerSessionId: ocBoot.acpSessionId,
          metadata: ocBoot.metadata,
        },
      };
      appendEvent(db, sessionId, {
        event: createdOpenCode.event,
        timestamp: createdOpenCode.timestamp,
        payload: createdOpenCode.payload,
      });
      registry.broadcastFrame(encodeFrame(createdOpenCode));

      send(encodeFrame(okResponse(req.id, { sessionId })));
      return;
    }

    if (req.method === "session.resume") {
      const params = (req.params ?? {}) as { sessionId?: string };
      if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
        send(encodeFrame(errResponse(req.id, "INVALID_PARAMS", "sessionId required")));
        return;
      }

      const row = resumeSessionById(db, params.sessionId);
      if (!row) {
        send(encodeFrame(errResponse(req.id, "SESSION_NOT_FOUND", "unknown session")));
        return;
      }
      if (row.state === "archived") {
        send(encodeFrame(errResponse(req.id, "SESSION_ARCHIVED", "session is archived")));
        return;
      }
      if (registry.getSession(params.sessionId)) {
        send(encodeFrame(okResponse(req.id, { sessionId: params.sessionId, alreadyLoaded: true })));
        return;
      }

      if (row.provider === "fake") {
        registry.registerSession(params.sessionId, {
          provider: "fake",
          adapter: fakeAdapter,
          activeTurnId: null,
        });
        send(encodeFrame(okResponse(req.id, { sessionId: params.sessionId })));
        return;
      }

      if (row.provider === "codex") {
        if (typeof row.providerSessionId !== "string" || row.providerSessionId.length === 0) {
          send(
            encodeFrame(
              errResponse(
                req.id,
                "SESSION_INCOMPLETE",
                "codex thread id missing; create a new session",
              ),
            ),
          );
          return;
        }

        let transport: LineTransport;
        try {
          transport = mkCodexTransport({ workspaceRoot: row.workspaceRoot });
        } catch (e: unknown) {
          const c = classifyCodexFailure(e);
          send(encodeFrame(errResponse(req.id, c.code, c.message, { cause: String(e) })));
          return;
        }

        try {
          const boot = await bootstrapCodexResumeThread(transport, {
            db,
            harnessSessionId: params.sessionId,
            workspaceRoot: row.workspaceRoot,
            threadId: row.providerSessionId,
            metadata: row.metadata,
          });
          const codexMeta = boot.metadata.codex as Record<string, unknown> | undefined;
          const model = typeof codexMeta?.model === "string" ? codexMeta.model : "gpt-5.4";
          const adapter = new CodexProviderAdapter(boot.rpc, {
            harnessSessionId: params.sessionId,
            threadId: row.providerSessionId,
            workspaceRoot: row.workspaceRoot,
            model,
          });
          registry.registerSession(params.sessionId, {
            provider: "codex",
            adapter,
            activeTurnId: null,
          });
        } catch (e: unknown) {
          await transport.close().catch(() => {});
          const rec = e as { code?: string; message?: string };
          const code =
            typeof rec.code === "string" && rec.code.length > 0 ? rec.code : "CODEX_SETUP_FAILED";
          const message = e instanceof Error ? e.message : String(e);
          send(encodeFrame(errResponse(req.id, code, message, { detail: e })));
          return;
        }

        send(encodeFrame(okResponse(req.id, { sessionId: params.sessionId })));
        return;
      }

      if (row.provider === "opencode") {
        if (typeof row.providerSessionId !== "string" || row.providerSessionId.length === 0) {
          send(
            encodeFrame(
              errResponse(
                req.id,
                "SESSION_INCOMPLETE",
                "opencode session id missing; create a new session",
              ),
            ),
          );
          return;
        }

        let ocTransport: LineTransport;
        try {
          ocTransport = mkOpenCodeTransport({ workspaceRoot: row.workspaceRoot });
        } catch (e: unknown) {
          const c = classifyOpenCodeFailure(e);
          send(encodeFrame(errResponse(req.id, c.code, c.message, { cause: String(e) })));
          return;
        }

        try {
          const boot = await bootstrapOpenCodeLoadSession(ocTransport, {
            db,
            harnessSessionId: params.sessionId,
            workspaceRoot: row.workspaceRoot,
            acpSessionId: row.providerSessionId,
            metadata: row.metadata,
          });
          const adapter = new OpenCodeProviderAdapter(boot.rpc, {
            harnessSessionId: params.sessionId,
            opencodeSessionId: row.providerSessionId,
            workspaceRoot: row.workspaceRoot,
          });
          registry.registerSession(params.sessionId, {
            provider: "opencode",
            adapter,
            activeTurnId: null,
          });
        } catch (e: unknown) {
          await ocTransport.close().catch(() => {});
          const rec = e as { code?: string; message?: string };
          const code =
            typeof rec.code === "string" && rec.code.length > 0
              ? rec.code
              : "OPENCODE_SETUP_FAILED";
          const message = e instanceof Error ? e.message : String(e);
          send(encodeFrame(errResponse(req.id, code, message, { detail: e })));
          return;
        }

        send(encodeFrame(okResponse(req.id, { sessionId: params.sessionId })));
        return;
      }

      send(
        encodeFrame(
          errResponse(req.id, "UNSUPPORTED_PROVIDER", "resume not supported for this provider", {
            provider: row.provider,
          }),
        ),
      );
      return;
    }

    if (req.method === "session.archive") {
      const params = (req.params ?? {}) as { sessionId?: string };
      if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
        send(encodeFrame(errResponse(req.id, "INVALID_PARAMS", "sessionId required")));
        return;
      }

      const row = resumeSessionById(db, params.sessionId);
      if (!row) {
        send(encodeFrame(errResponse(req.id, "SESSION_NOT_FOUND", "unknown session")));
        return;
      }

      const rt = registry.getSession(params.sessionId);
      if ((row.provider === "codex" || row.provider === "opencode") && !rt) {
        send(
          encodeFrame(
            errResponse(
              req.id,
              "SESSION_NOT_LOADED",
              "load the session in the daemon (session.resume) before archiving so the provider connection can be closed",
            ),
          ),
        );
        return;
      }

      if (rt?.adapter.archiveSession) {
        try {
          await rt.adapter.archiveSession();
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          send(encodeFrame(errResponse(req.id, "ARCHIVE_FAILED", message, { detail: e })));
          return;
        }
      }

      if (rt) {
        registry.unregisterSession(params.sessionId);
      }
      updateSessionState(db, params.sessionId, "archived");
      send(encodeFrame(okResponse(req.id, { ok: true })));
      return;
    }

    if (req.method === "session.prompt") {
      const params = (req.params ?? {}) as { sessionId?: string; text?: string };
      if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
        send(encodeFrame(errResponse(req.id, "INVALID_PARAMS", "sessionId required")));
        return;
      }
      if (typeof params.text !== "string") {
        send(encodeFrame(errResponse(req.id, "INVALID_PARAMS", "text required")));
        return;
      }

      const sessionId = params.sessionId;
      const row = resumeSessionById(db, sessionId);
      if (!row) {
        send(encodeFrame(errResponse(req.id, "SESSION_NOT_FOUND", "unknown session")));
        return;
      }

      const runtime = registry.getSession(sessionId);
      if (!runtime) {
        send(
          encodeFrame(errResponse(req.id, "SESSION_NOT_LOADED", "session not active in daemon")),
        );
        return;
      }

      if (runtime.activeTurnId !== null) {
        send(
          encodeFrame(
            errResponse(req.id, "TURN_IN_PROGRESS", "only one active prompt turn per session"),
          ),
        );
        return;
      }

      const turnId = randomUUID();
      runtime.activeTurnId = turnId;
      const emit = emitForSession(sessionId);

      send(encodeFrame(okResponse(req.id, { turnId })));

      const ctx = {
        sessionId,
        turnId,
        text: params.text,
        db,
        emit,
      };

      const turnPromise = runtime.adapter
        .onPromptTurn(ctx)
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          const failed: DaemonEvent = {
            event: "session.failed",
            sessionId,
            timestamp: Date.now(),
            payload: { turnId, message: msg },
          };
          emit(failed);
        })
        .finally(() => {
          runtime.activeTurnId = null;
          inFlightTurns.delete(turnPromise);
        });
      inFlightTurns.add(turnPromise);

      return;
    }

    if (req.method === "approval.resolve") {
      const params = (req.params ?? {}) as { approvalId?: string; resolution?: unknown };
      if (typeof params.approvalId !== "string") {
        send(encodeFrame(errResponse(req.id, "INVALID_PARAMS", "approvalId required")));
        return;
      }

      const row = getApproval(db, params.approvalId);
      if (!row) {
        send(encodeFrame(errResponse(req.id, "NOT_FOUND", "unknown approval")));
        return;
      }

      updateApprovalResolution(db, params.approvalId, {
        state: "resolved",
        resolution: params.resolution ?? null,
      });

      const resolved: DaemonEvent = {
        event: "approval.resolved",
        sessionId: row.sessionId,
        timestamp: Date.now(),
        payload: { approvalId: params.approvalId, turnId: row.turnId },
      };
      appendEvent(db, row.sessionId, {
        event: resolved.event,
        timestamp: resolved.timestamp,
        payload: resolved.payload,
      });
      registry.broadcastFrame(encodeFrame(resolved));

      const rt = registry.getSession(row.sessionId);
      rt?.adapter.notifyApprovalResolved(params.approvalId);

      send(encodeFrame(okResponse(req.id, { ok: true })));
      return;
    }

    if (req.method === "diff.open") {
      const params = (req.params ?? {}) as { diffId?: string };
      if (typeof params.diffId !== "string" || params.diffId.length === 0) {
        send(encodeFrame(errResponse(req.id, "INVALID_PARAMS", "diffId required")));
        return;
      }
      const row = getDiffProposal(db, params.diffId);
      if (!row) {
        send(encodeFrame(errResponse(req.id, "NOT_FOUND", "unknown diff proposal")));
        return;
      }
      const session = resumeSessionById(db, row.sessionId);
      if (!session) {
        send(encodeFrame(errResponse(req.id, "SESSION_NOT_FOUND", "session missing for proposal")));
        return;
      }
      send(
        encodeFrame(
          okResponse(req.id, {
            sessionId: row.sessionId,
            path: row.path,
            workspaceRoot: session.workspaceRoot,
            proposedContent: row.proposal.proposedContent,
            originalContentHash: row.proposal.originalContentHash,
            provider: row.proposal.provider ?? null,
          }),
        ),
      );
      return;
    }

    if (req.method === "diff.apply") {
      const params = (req.params ?? {}) as { diffId?: string };
      if (typeof params.diffId !== "string" || params.diffId.length === 0) {
        send(encodeFrame(errResponse(req.id, "INVALID_PARAMS", "diffId required")));
        return;
      }
      const row = getDiffProposal(db, params.diffId);
      if (!row) {
        send(encodeFrame(errResponse(req.id, "NOT_FOUND", "unknown diff proposal")));
        return;
      }
      if (row.state !== "pending") {
        send(
          encodeFrame(
            errResponse(req.id, "INVALID_STATE", "diff proposal is not pending", {
              state: row.state,
            }),
          ),
        );
        return;
      }
      const session = resumeSessionById(db, row.sessionId);
      if (!session) {
        send(encodeFrame(errResponse(req.id, "SESSION_NOT_FOUND", "session missing for proposal")));
        return;
      }
      const absPath = isAbsolute(row.path) ? row.path : join(session.workspaceRoot, row.path);
      let diskContent = "";
      try {
        diskContent = readFileSync(absPath, "utf8");
      } catch {
        diskContent = "";
      }
      if (hashContentUtf8(diskContent) !== row.proposal.originalContentHash) {
        send(
          encodeFrame(
            errResponse(
              req.id,
              "CONTENT_CHANGED",
              "file content no longer matches proposal baseline",
            ),
          ),
        );
        return;
      }
      try {
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, row.proposal.proposedContent, "utf8");
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        send(encodeFrame(errResponse(req.id, "WRITE_FAILED", message, { detail: e })));
        return;
      }
      updateDiffProposalState(db, row.id, "accepted");
      send(encodeFrame(okResponse(req.id, { ok: true })));
      return;
    }

    if (req.method === "diff.reject") {
      const params = (req.params ?? {}) as { diffId?: string };
      if (typeof params.diffId !== "string" || params.diffId.length === 0) {
        send(encodeFrame(errResponse(req.id, "INVALID_PARAMS", "diffId required")));
        return;
      }
      const row = getDiffProposal(db, params.diffId);
      if (!row) {
        send(encodeFrame(errResponse(req.id, "NOT_FOUND", "unknown diff proposal")));
        return;
      }
      if (row.state !== "pending") {
        send(
          encodeFrame(
            errResponse(req.id, "INVALID_STATE", "diff proposal is not pending", {
              state: row.state,
            }),
          ),
        );
        return;
      }
      updateDiffProposalState(db, row.id, "rejected");
      send(encodeFrame(okResponse(req.id, { ok: true })));
      return;
    }

    send(
      encodeFrame(errResponse(req.id, "NOT_IMPLEMENTED", `method not implemented: ${req.method}`)),
    );
  };

  return new Promise((resolve, reject) => {
    const server: Server = createServer((sock: Socket) => {
      const connId = randomUUID();
      const dec = new FrameDecoder();
      const authenticated = { value: false };
      sockets.add(sock);

      const send: UiSend = (buf) => {
        sock.write(buf);
      };

      sock.on("data", (chunk: Buffer) => {
        const u8 = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        let jsons: string[];
        try {
          jsons = dec.push(u8);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          try {
            sock.write(encodeFrame(errResponse("", "FRAME_ERROR", msg)));
          } catch {
            /* ignore */
          }
          sock.destroy();
          return;
        }

        void (async () => {
          for (const json of jsons) {
            await handleLine(connId, json, authenticated, send);
          }
        })();
      });

      sock.on("close", () => {
        sockets.delete(sock);
        registry.removeUiClient(connId);
      });

      sock.on("error", () => {
        sockets.delete(sock);
        registry.removeUiClient(connId);
      });
    });

    server.on("error", reject);

    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("server address unavailable"));
        return;
      }
      resolve({
        port: addr.port,
        close: () => {
          if (closePromise) return closePromise;
          closePromise = (async () => {
            const serverClosed = new Promise<void>((resolveServer, rejectServer) => {
              server.close((err) => {
                if (err) {
                  rejectServer(err);
                  return;
                }
                resolveServer();
              });
            });

            await Promise.allSettled([...inFlightTurns]);

            for (const sock of sockets) {
              sock.destroy();
            }

            await serverClosed;
          })();
          return closePromise;
        },
      });
    });
  });
}

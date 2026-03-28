export const KNOWN_METHODS = [
  "daemon.hello",
  "session.list",
  "session.create",
  "session.resume",
  "session.stop",
  "session.archive",
  "session.prompt",
  "approval.resolve",
  "diff.open",
  "diff.apply",
  "diff.reject",
  "workspace.addFileContext",
] as const;

export type KnownMethod = (typeof KNOWN_METHODS)[number];

const knownSet = new Set<string>(KNOWN_METHODS);

export type ClientRequest = {
  id: string;
  method: KnownMethod;
  params?: unknown;
};

export type ProtocolErrorShape = {
  code: string;
  message: string;
  detail?: unknown;
};

export type ClientResponseOk = {
  replyTo: string;
  ok: true;
  result?: unknown;
};

export type ClientResponseErr = {
  replyTo: string;
  ok: false;
  error: ProtocolErrorShape;
};

export type ClientResponse = ClientResponseOk | ClientResponseErr;

export type DaemonEvent = {
  event: string;
  sessionId: string;
  timestamp: number;
  payload: Record<string, unknown> & {
    provider?: unknown;
  };
};

export type DaemonToClientMessage = ClientResponse | DaemonEvent;

export type ParseClientRequestResult =
  | { ok: true; request: ClientRequest }
  | { ok: false; replyTo: string; error: ProtocolErrorShape };

export function parseClientRequest(value: unknown): ParseClientRequestResult {
  if (typeof value !== "object" || value === null) {
    return {
      ok: false,
      replyTo: "",
      error: { code: "INVALID_REQUEST", message: "request must be a JSON object" },
    };
  }
  const o = value as Record<string, unknown>;
  const id = o.id;
  const method = o.method;
  if (typeof id !== "string" || id.length === 0) {
    return {
      ok: false,
      replyTo: typeof id === "string" ? id : "",
      error: { code: "INVALID_REQUEST", message: "request.id must be a non-empty string" },
    };
  }
  if (typeof method !== "string") {
    return {
      ok: false,
      replyTo: id,
      error: { code: "INVALID_REQUEST", message: "request.method must be a string" },
    };
  }
  if (!knownSet.has(method)) {
    return {
      ok: false,
      replyTo: id,
      error: {
        code: "UNKNOWN_METHOD",
        message: `unknown method: ${method}`,
        detail: { method },
      },
    };
  }
  const request: ClientRequest = {
    id,
    method: method as KnownMethod,
    params: o.params,
  };
  return { ok: true, request };
}

export function isResponse(value: unknown): value is ClientResponse {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return typeof o.replyTo === "string" && typeof o.ok === "boolean";
}

export function isDaemonEvent(value: unknown): value is DaemonEvent {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  if (typeof o.event !== "string") return false;
  if (typeof o.sessionId !== "string") return false;
  if (typeof o.timestamp !== "number") return false;
  if (typeof o.payload !== "object" || o.payload === null) return false;
  return true;
}

export function isDaemonToClientMessage(value: unknown): value is DaemonToClientMessage {
  return isResponse(value) || isDaemonEvent(value);
}

export type PersistedEventRow = {
  seq: number;
  event: string;
  timestamp: number;
  payload: DaemonEvent["payload"];
};

export function persistedEventRowShape(ev: DaemonEvent, seq: number): PersistedEventRow {
  return {
    seq,
    event: ev.event,
    timestamp: ev.timestamp,
    payload: ev.payload,
  };
}

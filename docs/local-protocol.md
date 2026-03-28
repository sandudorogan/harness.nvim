# Local protocol (v1)

Neovim talks to `harnessd` over a single localhost TCP connection. Traffic is **length-prefixed JSON frames**. Requests from the editor, responses from the daemon, and **events** from the daemon share the same socket and **may arrive interleaved**.

Reference constants and helpers live in `apps/harnessd/src/protocol/encode.ts` and `apps/harnessd/src/protocol/types.ts`.

## Why framed TCP and length-prefix JSON

This wire format is deliberate:

- **Simple from Lua** — `vim.uv` TCP read loop + length prefix avoids embedding a full HTTP/WebSocket stack in the editor  
- **Safe for large and multiline payloads** — file proposals and transcripts are not newline-delimited; the reader never scans for delimiters inside the body  
- **Inspectable** — hex dumps and small scripts can decode frames without special tooling  
- **Decoupled from provider transports** — Codex/OpenCode still speak their own stdio protocols; this layer is only **Neovim ↔ daemon**  
- **Portable** — same pattern works across platforms; no browser or Electron dependency  

See `docs/architecture.md` for how this fits next to provider subprocesses and SQLite.

## Frame format

Each frame is:

1. **4 bytes**: payload length `N` as an **unsigned 32-bit big-endian** integer.
2. **`N` bytes**: the payload as **UTF-8** text that MUST parse as a single JSON value (almost always a JSON object).

There is no delimiter beyond `N`; multiline strings and large blobs are safe because the reader never scans for newlines inside the frame.

### Maximum frame size

Both the daemon and the client MUST reject any frame whose declared `N` is greater than **`MAX_FRAME_BYTES`**, currently **16 MiB** (`16 * 1024 * 1024`), exported as `MAX_FRAME_BYTES` from `encode.ts`. The same limit applies to encoding: the UTF-8 byte length of the JSON body must not exceed `MAX_FRAME_BYTES`.

Oversized frames must be rejected **using the declared length** once the 4-byte prefix is available; implementations must not require the full body to be buffered first to enforce the limit.

## JSON envelopes

Field names are **camelCase** in JSON as shown below (e.g. `sessionId`, `replyTo`). The wire model matches `PLAN.md`.

### Client → daemon (request)

```json
{
  "id": "<opaque string; correlate with responses>",
  "method": "<command>",
  "params": {}
}
```

- `id` is required and MUST be unique among in-flight requests from that connection (UUIDs are fine).
- `method` MUST be one of the known v1 methods (see `KNOWN_METHODS` in `types.ts`). Unknown methods are rejected at the parse boundary with `UNKNOWN_METHOD` (see below).
- `params` is optional; when omitted, daemons should treat it like `{}`.

### Daemon → client (response)

Success:

```json
{
  "replyTo": "<same id as the request>",
  "ok": true,
  "result": {}
}
```

Failure:

```json
{
  "replyTo": "<same id as the request>",
  "ok": false,
  "error": {
    "code": "<machine string>",
    "message": "<human text>",
    "detail": null
  }
}
```

`detail` is optional and may carry structured context (for example the unknown `method` name).

### Daemon → client (event)

```json
{
  "event": "<event name>",
  "sessionId": "<session id>",
  "timestamp": 1700000000000,
  "payload": {}
}
```

- `timestamp` is milliseconds since Unix epoch (`Date.now()` semantics).
- Normalized fields live at the top of `payload`. **Provider-native data MUST stay under** `payload.provider` and MUST NOT be discarded when mapping provider streams into local events.

## Interleaving and concurrency

- **Multiple in-flight requests** are allowed on one connection. Every response includes `replyTo` matching the request `id`.
- **Events** are not tied to a request id. Clients MUST handle events **between** any pair of responses.
- **Only one active prompt turn** is allowed per session in v1. The daemon enforces this when processing `session.prompt` (server task); the wire shape stays the same either way.

### `session.prompt` completion semantics

`session.prompt` **returns immediately** after the daemon accepts the turn and allocates a **turn id**. The JSON response MUST NOT block on model completion. Progress (tokens, tool calls, approvals, diffs, errors) is delivered **only** through **events** on the same socket, for example `message.delta`, `message.completed`, `session.failed`, etc., all carrying the same `sessionId` and turn-related fields inside `payload` as defined by the daemon implementation.

## Parsing helpers

TypeScript code can use:

- `encodeFrame` / `FrameDecoder` / `decodeCompleteFrame` for framing.
- `parseClientRequest` for method validation and stable `UNKNOWN_METHOD` errors.
- `isResponse` / `isDaemonEvent` / `isDaemonToClientMessage` to classify parsed JSON from the daemon.

The Neovim client should mirror the same limits and classification logic in Lua when decoding frames from `vim.uv`.

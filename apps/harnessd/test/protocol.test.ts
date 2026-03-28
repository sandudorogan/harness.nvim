import { describe, expect, test } from "bun:test";
import {
  decodeCompleteFrame,
  encodeFrame,
  FrameDecoder,
  MAX_FRAME_BYTES,
} from "../src/protocol/encode.ts";
import type { ClientRequest, DaemonEvent } from "../src/protocol/types.ts";
import {
  isDaemonEvent,
  isDaemonToClientMessage,
  isResponse,
  parseClientRequest,
  persistedEventRowShape,
} from "../src/protocol/types.ts";

describe("frame encoding and decoding", () => {
  test("round-trips JSON object as UTF-8 body with 4-byte big-endian length prefix", () => {
    const body = { hello: "world", n: 42 };
    const wire = encodeFrame(body);
    expect(wire.length).toBeGreaterThanOrEqual(4);
    const dv = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
    const declared = dv.getUint32(0, false);
    const jsonBytes = wire.subarray(4);
    expect(jsonBytes.length).toBe(declared);
    expect(new TextDecoder().decode(jsonBytes)).toBe(JSON.stringify(body));
    const parsed = decodeCompleteFrame(wire);
    expect(parsed).toEqual(body);
  });

  test("rejects declared length larger than MAX_FRAME_BYTES before reading body", () => {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false);
    expect(() => decodeCompleteFrame(out)).toThrow(/frame too large/i);
  });

  test("rejects body whose UTF-8 byte length exceeds MAX_FRAME_BYTES", () => {
    const huge = "x".repeat(MAX_FRAME_BYTES + 1);
    expect(() => encodeFrame(huge)).toThrow(/frame too large/i);
  });
});

describe("multiline payload safety", () => {
  test("preserves newlines inside JSON string values across encode/decode", () => {
    const body = {
      id: "1",
      method: "session.prompt",
      params: { text: "line1\nline2\n\tindented" },
    };
    const wire = encodeFrame(body);
    expect(decodeCompleteFrame(wire)).toEqual(body);
  });
});

describe("unknown command rejection at codec boundary", () => {
  test("parseClientRequest returns structured error for unknown method", () => {
    const raw = {
      id: "req-unknown",
      method: "not.a.real.method",
      params: {},
    };
    const r = parseClientRequest(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.replyTo).toBe("req-unknown");
      expect(r.error.code).toBe("UNKNOWN_METHOD");
      expect(r.error.message).toMatch(/unknown method/i);
    }
  });

  test("accepts a known method as ClientRequest", () => {
    const raw: ClientRequest = {
      id: "a",
      method: "daemon.hello",
      params: {},
    };
    const r = parseClientRequest(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request).toEqual(raw);
  });
});

describe("event persistence shape", () => {
  test("persistedEventRowShape matches stored event columns", () => {
    const ev: DaemonEvent = {
      event: "message.delta",
      sessionId: "sess-1",
      timestamp: 1_700_000_000_000,
      payload: { text: "hi", provider: { raw: true } },
    };
    const row = persistedEventRowShape(ev, 7);
    expect(row).toEqual({
      seq: 7,
      event: "message.delta",
      timestamp: 1_700_000_000_000,
      payload: { text: "hi", provider: { raw: true } },
    });
  });
});

describe("interleaved request and event handling", () => {
  test("FrameDecoder yields multiple frames in arrival order from one chunk", () => {
    const e1: DaemonEvent = {
      event: "message.delta",
      sessionId: "s",
      timestamp: 1,
      payload: { a: 1 },
    };
    const e2: DaemonEvent = {
      event: "message.completed",
      sessionId: "s",
      timestamp: 2,
      payload: { b: 2 },
    };
    const f1 = encodeFrame({ replyTo: "r1", ok: true, result: { turnId: "t1" } });
    const f2 = encodeFrame(e1);
    const f3 = encodeFrame({ replyTo: "r2", ok: false, error: { code: "X", message: "m" } });
    const f4 = encodeFrame(e2);
    const merged = new Uint8Array(f1.length + f2.length + f3.length + f4.length);
    merged.set(f1, 0);
    merged.set(f2, f1.length);
    merged.set(f3, f1.length + f2.length);
    merged.set(f4, f1.length + f2.length + f3.length);

    const dec = new FrameDecoder();
    const jsons = dec.push(merged);
    expect(jsons).toHaveLength(4);

    const m0 = JSON.parse(jsons[0]!);
    const m1 = JSON.parse(jsons[1]!);
    const m2 = JSON.parse(jsons[2]!);
    const m3 = JSON.parse(jsons[3]!);

    expect(isResponse(m0)).toBe(true);
    expect(isDaemonEvent(m1)).toBe(true);
    expect(isResponse(m2)).toBe(true);
    expect(isDaemonEvent(m3)).toBe(true);

    expect(isDaemonToClientMessage(m0)).toBe(true);
    expect(isDaemonToClientMessage(m1)).toBe(true);
    expect(isDaemonToClientMessage(m2)).toBe(true);
    expect(isDaemonToClientMessage(m3)).toBe(true);
  });

  test("FrameDecoder handles split chunk boundaries", () => {
    const inner = { replyTo: "x", ok: true, result: {} };
    const wire = encodeFrame(inner);
    const dec = new FrameDecoder();
    expect(dec.push(wire.subarray(0, 2))).toEqual([]);
    expect(dec.push(wire.subarray(2))).toEqual([JSON.stringify(inner)]);
  });
});

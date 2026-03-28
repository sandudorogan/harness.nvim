import { Buffer } from "node:buffer";

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

function readUint32BE(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset + offset, 4).getUint32(0, false);
}

export function encodeFrame(body: unknown): Uint8Array {
  const json = typeof body === "string" ? body : JSON.stringify(body);
  const bodyBuf = Buffer.from(json, "utf8");
  if (bodyBuf.length > MAX_FRAME_BYTES) {
    throw new Error(`frame too large: ${bodyBuf.length} bytes (max ${MAX_FRAME_BYTES})`);
  }
  const out = new Uint8Array(4 + bodyBuf.length);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(0, bodyBuf.length, false);
  out.set(bodyBuf, 4);
  return out;
}

export function decodeCompleteFrame(wire: Uint8Array): unknown {
  if (wire.length < 4) {
    throw new Error("incomplete frame: missing length prefix");
  }
  const len = readUint32BE(wire, 0);
  if (len > MAX_FRAME_BYTES) {
    throw new Error(`frame too large: declared ${len} bytes (max ${MAX_FRAME_BYTES})`);
  }
  if (wire.length !== 4 + len) {
    throw new Error(`frame length mismatch: expected ${4 + len} bytes, got ${wire.length}`);
  }
  const text = Buffer.from(wire.subarray(4)).toString("utf8");
  return JSON.parse(text) as unknown;
}

export class FrameDecoder {
  private buf = new Uint8Array(0);

  private append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const next = new Uint8Array(this.buf.length + chunk.length);
    next.set(this.buf);
    next.set(chunk, this.buf.length);
    this.buf = next;
  }

  push(chunk: Uint8Array): string[] {
    this.append(chunk);
    const out: string[] = [];
    while (this.buf.length >= 4) {
      const len = readUint32BE(this.buf, 0);
      if (len > MAX_FRAME_BYTES) {
        throw new Error(`frame too large: declared ${len} bytes (max ${MAX_FRAME_BYTES})`);
      }
      if (this.buf.length < 4 + len) break;
      const slice = this.buf.subarray(4, 4 + len);
      out.push(Buffer.from(slice).toString("utf8"));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}

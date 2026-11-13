import { SurfaceFailure } from "../sources/runtime.ts";
import { serverMessageSchema, type ServerFrame, type ServerMessage } from "./protocol.ts";

export class LineDecoder {
  private readonly fragments: Buffer[] = [];
  private pendingBytes = 0;
  private tailBytes = 0;
  private maxBytes: number;
  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }
  setLimit(maxBytes: number): void {
    this.maxBytes = maxBytes;
    this.checkLimit(this.pendingBytes);
  }
  private checkLimit(bytes: number): void {
    if (bytes > this.maxBytes)
      throw new SurfaceFailure({
        code: "transport_limit",
        message: "IPC frame exceeds the negotiated byte limit",
      });
  }
  private append(bytes: Buffer): void {
    this.checkLimit(this.pendingBytes + bytes.length);
    let offset = 0;
    while (offset < bytes.length) {
      let tail = this.fragments.at(-1);
      if (!tail || this.tailBytes === tail.length) {
        tail = Buffer.allocUnsafe(Math.min(64 * 1024, this.maxBytes - this.pendingBytes));
        this.fragments.push(tail);
        this.tailBytes = 0;
      }
      const length = Math.min(bytes.length - offset, tail.length - this.tailBytes);
      bytes.copy(tail, this.tailBytes, offset, offset + length);
      this.tailBytes += length;
      this.pendingBytes += length;
      offset += length;
    }
  }
  // Yield between frames so authentication can change the limit even when
  // welcome and the first large message arrive in the same socket read.
  *frames(input: Uint8Array): Generator<unknown> {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    let offset = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset);
      if (end < 0) {
        this.append(bytes.subarray(offset));
        return;
      }
      this.checkLimit(this.pendingBytes + end - offset);
      let line = bytes.subarray(offset, end);
      if (this.pendingBytes) {
        this.append(line);
        const tail = this.fragments.pop();
        if (tail) this.fragments.push(tail.subarray(0, this.tailBytes));
        line = Buffer.concat(this.fragments, this.pendingBytes);
        this.fragments.length = 0;
        this.pendingBytes = 0;
        this.tailBytes = 0;
      }
      offset = end + 1;
      try {
        yield JSON.parse(line.toString("utf8"));
      } catch {
        throw new SurfaceFailure({ code: "invalid_input", message: "IPC frame is not valid JSON" });
      }
    }
  }
  push(bytes: Uint8Array): unknown[] {
    return [...this.frames(bytes)];
  }
  finish(): void {
    if (this.pendingBytes)
      throw new SurfaceFailure({ code: "invalid_input", message: "IPC ended inside a JSON frame" });
  }
}

export function encodeFrame(value: unknown, maxBytes: number): Buffer {
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  if (bytes.length - 1 > maxBytes)
    throw new SurfaceFailure({
      code: "transport_limit",
      message: "IPC frame exceeds the negotiated byte limit",
    });
  return bytes;
}

export class MessageDecoder {
  private current?: { id: string; total: number; offset: number; parts: Buffer[] };
  private readonly maxBytes: number;
  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }
  push(frame: Extract<ServerFrame, { type: "part" }>): ServerMessage | undefined {
    if (frame.total > this.maxBytes)
      throw new SurfaceFailure({
        code: "transport_limit",
        message: "IPC message exceeds the negotiated byte limit",
      });
    const bytes = Buffer.from(frame.data, "base64");
    if (!bytes.length || bytes.toString("base64") !== frame.data)
      throw new SurfaceFailure({
        code: "invalid_input",
        message: "IPC message part has invalid encoding",
      });
    if (!this.current) {
      if (frame.offset !== 0)
        throw new SurfaceFailure({
          code: "invalid_input",
          message: "IPC message starts at a nonzero byte offset",
        });
      this.current = { id: frame.id, total: frame.total, offset: 0, parts: [] };
    }
    const current = this.current;
    if (
      frame.id !== current.id ||
      frame.total !== current.total ||
      frame.offset !== current.offset ||
      frame.offset + bytes.length > frame.total
    )
      throw new SurfaceFailure({
        code: "invalid_input",
        message: "IPC message parts are missing, reordered or mismatched",
      });
    current.parts.push(bytes);
    current.offset += bytes.length;
    if (current.offset !== current.total) return undefined;
    this.current = undefined;
    try {
      return serverMessageSchema.parse(JSON.parse(Buffer.concat(current.parts).toString("utf8")));
    } catch {
      throw new SurfaceFailure({
        code: "invalid_input",
        message: "IPC message payload is invalid",
      });
    }
  }
  finish(): void {
    if (this.current)
      throw new SurfaceFailure({
        code: "invalid_input",
        message: "IPC ended inside a fragmented message",
      });
  }
}

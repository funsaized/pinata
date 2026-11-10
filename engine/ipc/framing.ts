import { SurfaceFailure } from "../sources/runtime.ts";
import { serverMessageSchema, type ServerFrame, type ServerMessage } from "./protocol.ts";

export class LineDecoder {
  private pending = Buffer.alloc(0);
  private maxBytes: number;
  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }
  setLimit(maxBytes: number): void {
    this.maxBytes = maxBytes;
    if (this.pending.length > maxBytes)
      throw new SurfaceFailure({
        code: "transport_limit",
        message: "IPC frame exceeds the negotiated byte limit",
      });
  }
  push(bytes: Uint8Array): unknown[] {
    this.pending = Buffer.concat([this.pending, bytes]);
    const frames: unknown[] = [];
    while (true) {
      const end = this.pending.indexOf(10);
      if (end < 0) break;
      if (end > this.maxBytes)
        throw new SurfaceFailure({
          code: "transport_limit",
          message: "IPC frame exceeds the negotiated byte limit",
        });
      const line = this.pending.subarray(0, end);
      this.pending = this.pending.subarray(end + 1);
      try {
        frames.push(JSON.parse(line.toString("utf8")));
      } catch {
        throw new SurfaceFailure({ code: "invalid_input", message: "IPC frame is not valid JSON" });
      }
    }
    if (this.pending.length > this.maxBytes)
      throw new SurfaceFailure({
        code: "transport_limit",
        message: "IPC frame exceeds the negotiated byte limit",
      });
    return frames;
  }
  finish(): void {
    if (this.pending.length)
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

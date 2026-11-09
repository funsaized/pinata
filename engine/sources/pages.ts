import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  artifactRefSchema,
  canonicalJson,
  digestValue,
  DomainError,
  revisionSchema,
  toolPageRequestSchema,
  toolPageSchema,
  type ArtifactPort,
  type ArtifactRef,
  type ToolPage,
} from "../contracts/index.ts";
import { digestBytes } from "../storage/io.ts";

export const toolContentBytes = 32 * 1024;
const cursorSchema = z.strictObject({ artifact: artifactRefSchema, offset: revisionSchema });
type PageCursor = z.infer<typeof cursorSchema>;

// A page cursor grants access only to bytes already exposed by this presentation
// adapter. Retained artifacts hold the content; the live adapter holds no cache.
export class ToolPages {
  private readonly artifacts: ArtifactPort;
  private readonly scope: string;
  private readonly secret = randomBytes(32);

  constructor(options: { artifacts: ArtifactPort; scope: string }) {
    this.artifacts = options.artifacts;
    this.scope = digestValue(options.scope);
  }

  async format(value: unknown): Promise<string> {
    const text = canonicalJson(value);
    const bytes = Buffer.from(text);
    if (bytes.length <= toolContentBytes) return text;
    try {
      const artifact = await this.artifacts.put(bytes);
      this.verify(bytes, artifact);
      return canonicalJson(this.page(bytes, { artifact, offset: 0 }));
    } catch {
      // The operation already returned. A presentation/storage failure cannot
      // turn its accepted mutation into an invitation to dispatch it again.
      return canonicalJson({
        status: "error",
        error: {
          code: "context_unavailable",
          message:
            "Output paging failed. The original reply remains in tool details. Re-query status, results or the original request receipt; do not repeat a mutation under a new request ID.",
        },
      });
    }
  }

  async read(cursor: string): Promise<ToolPage> {
    const request = toolPageRequestSchema.safeParse({ cursor });
    if (!request.success)
      throw new DomainError(
        "invalid_input",
        "Tool page cursor is invalid; re-query the original read operation",
        "cursor",
      );
    const value = this.decode(request.data.cursor);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await this.artifacts.read(value.artifact));
      this.verify(bytes, value.artifact);
    } catch (cause) {
      const error = new DomainError(
        "context_unavailable",
        "Retained tool output is unavailable or changed; re-query the original read operation",
      );
      error.cause = cause;
      throw error;
    }
    if (value.offset >= bytes.length || (bytes[value.offset] & 0xc0) === 0x80)
      throw new DomainError("invalid_input", "Tool page cursor has an invalid byte boundary");
    return this.page(bytes, value);
  }

  private verify(bytes: Buffer, artifact: ArtifactRef): void {
    if (bytes.length !== artifact.size || digestBytes(bytes) !== artifact.digest)
      throw new DomainError("context_unavailable", "Tool output artifact integrity failure");
  }

  private page(bytes: Buffer, cursor: PageCursor): ToolPage {
    let length = Math.min(toolContentBytes - 1024, bytes.length - cursor.offset);
    for (;;) {
      let end = cursor.offset + length;
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      const complete = end === bytes.length;
      const page = toolPageSchema.parse({
        schemaVersion: 1,
        kind: "tool_output_page",
        encoding: "json-utf8",
        digest: cursor.artifact.digest,
        totalBytes: bytes.length,
        offset: cursor.offset,
        nextOffset: end,
        complete,
        text: bytes.subarray(cursor.offset, end).toString("utf8"),
        ...(!complete
          ? { nextCursor: this.encode({ ...cursor, offset: end }), readNext: "pinata_page" }
          : {}),
      });
      if (Buffer.byteLength(canonicalJson(page)) <= toolContentBytes) return page;
      // Escaping a JSON text fragment can expand it. Bound the actual envelope,
      // and always cut at a UTF-8 boundary so concatenated text remains exact.
      length = Math.floor(length / 2);
      if (length < 4)
        throw new DomainError("unsupported", "Tool page metadata exceeds the content limit");
    }
  }

  private encode(cursor: PageCursor): string {
    const payload = Buffer.from(canonicalJson(cursor)).toString("base64url");
    const signature = createHmac("sha256", this.secret)
      .update(this.scope)
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  private decode(cursor: string): PageCursor {
    try {
      const parts = cursor.split(".");
      if (parts.length !== 2) throw new Error("Invalid cursor framing");
      const expected = createHmac("sha256", this.secret)
        .update(this.scope)
        .update(parts[0])
        .digest();
      const supplied = Buffer.from(parts[1], "base64url");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        throw new Error("Invalid cursor signature");
      return cursorSchema.parse(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")));
    } catch {
      throw new DomainError(
        "invalid_input",
        "Tool page cursor expired, changed or belongs to another host; re-query the original read operation",
        "cursor",
      );
    }
  }
}

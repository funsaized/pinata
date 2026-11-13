import { join } from "node:path";
import type { ArtifactPort } from "../contracts/backend.ts";
import { artifactRefSchema, DomainError } from "../contracts/common.ts";
import {
  digestBytes,
  publishImmutable,
  readOptional,
  StorageError,
  type FaultHook,
} from "../storage/io.ts";
import { verifiedArtifact } from "./files.ts";

// The checkout journal outlives any one run. Keep its content and helper evidence
// beside it, while preserving run-local references returned to workspace callers.
export function applicationArtifacts(
  directory: string,
  source: ArtifactPort,
  fault?: FaultHook,
): ArtifactPort {
  const retain = async (bytes: Uint8Array) => {
    const reference = { digest: digestBytes(bytes), size: bytes.byteLength };
    await publishImmutable(
      join(directory, "artifacts", reference.digest),
      bytes,
      "application.artifact",
      fault,
    );
    return reference;
  };
  return {
    async put(bytes) {
      const reference = await source.put(bytes);
      if (reference.digest !== digestBytes(bytes) || reference.size !== bytes.byteLength)
        throw new DomainError("conflict", "Run artifact publication returned a different identity");
      return retain(bytes);
    },
    async read(input) {
      const reference = artifactRefSchema.parse(input);
      const retained = await readOptional(join(directory, "artifacts", reference.digest));
      if (retained) {
        if (retained.length !== reference.size || digestBytes(retained) !== reference.digest)
          throw new DomainError("conflict", `Application artifact is corrupt: ${reference.digest}`);
        return retained;
      }
      let bytes: Uint8Array;
      try {
        bytes = await verifiedArtifact(source, reference);
      } catch (cause) {
        throw new StorageError(
          "conflict",
          `Application artifact is unavailable in this checkout and run: ${reference.digest}. Reopen the originating run to retain legacy application evidence before using another run.`,
          { cause },
        );
      }
      await retain(bytes);
      return bytes;
    },
  };
}

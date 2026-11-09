import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { artifactRefSchema, type ArtifactRef } from "../../contracts/common.ts";
import { digestBytes, publishImmutable, replaceProjection } from "../../storage/io.ts";

export async function retainEvidence(directory: string, value: unknown): Promise<ArtifactRef> {
  const bytes = Buffer.from(JSON.stringify(value));
  const reference = { digest: digestBytes(bytes), size: bytes.length };
  await publishImmutable(
    join(directory, "evidence", reference.digest),
    bytes,
    "supervisor-evidence",
  );
  return reference;
}

export async function readEvidence(directory: string, input: ArtifactRef): Promise<Buffer> {
  const reference = artifactRefSchema.parse(input);
  const bytes = await readFile(join(directory, "evidence", reference.digest));
  if (bytes.length !== reference.size || digestBytes(bytes) !== reference.digest)
    throw new Error("Supervisor evidence failed its digest check");
  return bytes;
}

export async function writeProjection(
  directory: string,
  name: string,
  value: unknown,
): Promise<void> {
  await replaceProjection(
    join(directory, name),
    Buffer.from(JSON.stringify(value)),
    "supervisor-projection",
  );
}

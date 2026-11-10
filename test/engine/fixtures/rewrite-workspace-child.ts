import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  assignmentRefSchema,
  frozenWorkerSchema,
  artifactRefSchema,
  resultSchema,
} from "../../../engine/contracts/index.ts";
import { WorkspaceLayer } from "../../../engine/workspace/index.ts";
import { FixtureArtifacts } from "../rewrite-application-fixture.ts";

const input = z
  .strictObject({
    root: z.string(),
    storeDirectory: z.string(),
    artifactDirectory: z.string(),
    boundary: z.string(),
    request: z.strictObject({
      ref: assignmentRefSchema,
      worker: frozenWorkerSchema,
      ownerEpoch: z.string(),
      inputs: z
        .array(
          z.strictObject({
            ref: assignmentRefSchema,
            result: resultSchema,
            artifact: artifactRefSchema,
          }),
        )
        .default([]),
    }),
  })
  .parse(JSON.parse(await readFile(process.argv[2], "utf8")));
const layer = new WorkspaceLayer({
  root: input.root,
  storeDirectory: input.storeDirectory,
  fault(point) {
    if (point === input.boundary) process.exit(86);
  },
});
await layer.prepare(
  { ...input.request, artifacts: new FixtureArtifacts(join(input.artifactDirectory)) },
  new AbortController().signal,
);
throw new Error(`Workspace crash boundary was not observed: ${input.boundary}`);

import { ApplicationStore } from "../../../rewrite/engine/application/index.ts";
import { FixtureArtifacts, FixtureGit } from "../rewrite-application-fixture.ts";
import { join } from "node:path";
import { z } from "zod";
import { artifactRefSchema } from "../../../rewrite/engine/contracts/common.ts";

const request = z
  .strictObject({
    direction: z.enum(["apply", "rollback"]),
    boundary: z.string(),
    directory: z.string(),
    root: z.string(),
    snapshot: artifactRefSchema,
    operationId: z.string().optional(),
    production: z.boolean().optional(),
  })
  .parse(JSON.parse(process.argv[2]));
const artifacts = new FixtureArtifacts(join(request.directory, "artifacts"));
const application = await ApplicationStore.open({
  destination: request.root,
  artifacts,
  ...(request.production
    ? {}
    : {
        createGit: (options: ConstructorParameters<typeof FixtureGit>[0]) =>
          new FixtureGit(options),
      }),
  fault: (point) => {
    if (point === request.boundary) process.exit(85);
  },
});
try {
  if (request.direction === "apply") await application.apply({ snapshot: request.snapshot });
  else {
    if (!request.operationId) throw new Error("Rollback fixture requires an operation identity");
    await application.rollback(request.operationId);
  }
} finally {
  await application.close();
}
throw new Error(`Crash boundary was not observed: ${request.boundary}`);

import { z } from "zod";
import { identitySchema, revisionSchema } from "./common.ts";

export const ownerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  host: identitySchema,
  pid: revisionSchema.positive(),
  startIdentity: identitySchema,
  token: identitySchema,
  epoch: identitySchema,
});
export type Owner = z.infer<typeof ownerSchema>;

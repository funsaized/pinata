import type { TSchema } from "typebox";
import { z } from "zod";

// The only TypeBox boundary assertion. Pi normalizes transport scalars; callers
// must still parse the resulting value with the original canonical Zod schema.
export function piParameters(schema: z.ZodType): TSchema {
  return z.toJSONSchema(schema, { target: "draft-07", io: "input" }) as TSchema;
}

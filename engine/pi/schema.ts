import type { TSchema } from "typebox";
import type { z } from "zod";
import { jsonSchema } from "../contracts/json-schema.ts";

// The only TypeBox boundary assertion. Pi normalizes transport scalars; callers
// must still parse the resulting value with the original canonical Zod schema.
export function piParameters(schema: z.ZodType): TSchema {
  return jsonSchema(schema) as TSchema;
}

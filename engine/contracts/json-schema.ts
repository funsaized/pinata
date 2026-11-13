import { z } from "zod";

const generated = new WeakMap<z.ZodType, z.core.JSONSchema.JSONSchema>();

// Zod schema builders return new identities. Keep the generated value private
// because Pi and external callers can mutate their returned schema objects.
export function jsonSchema(schema: z.ZodType): z.core.JSONSchema.JSONSchema {
  let cached = generated.get(schema);
  if (!cached) {
    cached = z.toJSONSchema(schema, { target: "draft-07", io: "input" });
    generated.set(schema, cached);
  }
  return structuredClone(cached);
}

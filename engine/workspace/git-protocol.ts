import { z } from "zod";
import { configSchema } from "../contracts/config.ts";
import { digestSchema } from "../contracts/common.ts";

export const gitRequestSchema = z.strictObject({
  id: z.uuid(),
  cwd: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  input: z.string().optional(),
  program: z
    .strictObject({
      executable: z.string().min(1),
      passEnv: configSchema.shape.passEnv
        .removeDefault()
        .refine(
          (names) => names.every((name) => !name.startsWith("GIT_")),
          "Setup cannot inherit Git control variables",
        ),
      sourceRoot: z.string().min(1),
    })
    .optional(),
});
export const gitCommandResultSchema = z.strictObject({
  id: z.uuid(),
  requestDigest: digestSchema,
  code: z.number().int().nullable(),
  signal: z.string().nullable().optional(),
  error: z.string().optional(),
  stdout: digestSchema,
  stderr: digestSchema,
});

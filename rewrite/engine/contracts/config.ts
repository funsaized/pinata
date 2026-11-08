import { z } from "zod";
import {
  backendSchema,
  textSchema,
  modelSchema,
  revisionSchema,
  workspaceSchema,
} from "./common.ts";

export const paletteSchema = z.enum([
  "inherit",
  "pinata",
  "catppuccin-mocha",
  "catppuccin-latte",
  "gruvbox-dark",
  "gruvbox-light",
  "tokyo-night-night",
  "rose-pine-main",
  "rose-pine-dawn",
  "dracula",
  "nord",
  "one-dark",
  "one-light",
  "solarized-dark",
  "solarized-light",
  "terminal-default",
]);
export const configSchema = z.strictObject({
  schemaVersion: z.literal(4).default(4),
  workspace: workspaceSchema.default("shared"),
  models: z.record(z.string(), modelSchema).default({}),
  fallbacks: z.record(z.string(), z.array(modelSchema).max(5)).default({}),
  toolProviders: z
    .record(z.string(), z.strictObject({ extension: textSchema, tools: z.array(textSchema) }))
    .default({}),
  passEnv: z
    .array(
      z
        .string()
        .regex(/^[A-Z][A-Z0-9_]*$/)
        .refine(
          (key) =>
            !/^(PINATA_|HERDR_|PI_)/.test(key) &&
            !["NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].includes(key),
          "Unsafe environment variable",
        ),
    )
    .default([]),
  webExtension: textSchema.optional(),
  setup: z.union([z.literal(false), textSchema]).optional(),
  worktreeRoot: textSchema.optional(),
  codemode: z.boolean().default(true),
  includeUncommitted: z.boolean().default(true),
  mode: z.enum(["lean", "observe"]).default("lean"),
  backend: backendSchema.default("in-process"),
  execution: z
    .strictObject({ maxConcurrent: revisionSchema.positive().nullable().default(null) })
    .default({ maxConcurrent: null }),
  ui: z
    .strictObject({
      palette: paletteSchema.default("inherit"),
      motion: z.enum(["full", "reduced", "off"]).default("full"),
      keys: z.record(z.string(), textSchema).default({}),
    })
    .default({ palette: "inherit", motion: "full", keys: {} }),
});
export type Config = z.infer<typeof configSchema>;

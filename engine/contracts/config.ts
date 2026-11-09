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

// Input layers preserve omission so personal/project settings survive unrelated
// run overrides. Defaults belong to the fully resolved, persisted configuration.
const fields = configSchema.shape;
export const configLayerSchema = z.strictObject({
  schemaVersion: fields.schemaVersion.removeDefault().optional(),
  workspace: fields.workspace.removeDefault().optional(),
  models: fields.models.removeDefault().optional(),
  fallbacks: fields.fallbacks.removeDefault().optional(),
  toolProviders: fields.toolProviders.removeDefault().optional(),
  passEnv: fields.passEnv.removeDefault().optional(),
  webExtension: fields.webExtension,
  setup: fields.setup,
  worktreeRoot: fields.worktreeRoot,
  codemode: fields.codemode.removeDefault().optional(),
  includeUncommitted: fields.includeUncommitted.removeDefault().optional(),
  mode: fields.mode.removeDefault().optional(),
  backend: fields.backend.removeDefault().optional(),
  execution: fields.execution.removeDefault().optional(),
  ui: fields.ui.removeDefault().optional(),
});
export type ConfigLayer = z.infer<typeof configLayerSchema>;

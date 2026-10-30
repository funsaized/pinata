import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { need } from "../core/validate.ts";
import type { PinataConfig } from "./config.ts";

const BUILTIN = new Set(["read", "grep", "find", "ls", "bash", "edit", "write"]);
const WEB = ["web_enable", "web_search", "fetch_content", "get_search_content"];
export interface ToolExtension {
  path: string;
  digest: string;
  tools: string[];
}
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function resolveToolExtensions(
  tools: string[],
  config: PinataConfig,
  web: string | null | undefined,
  root: string,
): ToolExtension[] {
  const providers = [
    ...Object.values(config.toolProviders ?? {}),
    ...(web ? [{ extension: web, tools: WEB }] : []),
  ];
  const found = new Map<string, ToolExtension>();
  for (const tool of new Set(tools)) {
    if (BUILTIN.has(tool)) continue;
    const matches = providers.filter((p) => p.tools.includes(tool));
    need(
      matches.length === 1,
      matches.length
        ? `Multiple configured providers supply ${tool}`
        : `Tool ${tool} is unavailable. Configure toolProviders${WEB.includes(tool) ? " or load pi-web-access / set config.webExtension" : ""} before starting this agent.`,
    );
    const path = realpathSync(resolve(root, matches[0].extension));
    if (!found.has(path)) found.set(path, { path, digest: digest(path), tools: [] });
    found.get(path)!.tools.push(tool);
  }
  return [...found.values()];
}

// Records identify extension entry files, not a reproducible snapshot of their dependencies.
export function validateToolExtensions(extensions: ToolExtension[]): void {
  for (const extension of extensions)
    need(
      digest(extension.path) === extension.digest,
      `Extension changed since this run started: ${extension.path}. Restore it before resuming, or start a new run.`,
    );
}

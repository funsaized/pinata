// Persona text for each role, from prompts/<role>.md. The prompt-template frontmatter and
// argument placeholders are removed, and the closing paragraph about 0.7.0's JSON envelope
// is replaced: engine agents report through submit_result.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Role } from "../core/types.ts";

const PROMPTS = fileURLToPath(new URL("../../prompts/", import.meta.url));
const cache = new Map<Role, string>();

export function personaText(role: Role, dir = PROMPTS): string {
  const cached = dir === PROMPTS ? cache.get(role) : undefined;
  if (cached) return cached;
  let text = readFileSync(`${dir}${role}.md`, "utf8").replace(/\r\n/g, "\n");
  text = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  text = text.replace(/\$\{@:-([^}]*)\}/g, "$1").replace(/\$\{@\}/g, "the assigned task");
  text = text.replace(
    /\nIn a managed pinata run[\s\S]*?(?=\n\n|\s*$)/,
    "\nIn a managed pinata run, report through the submit_result tool, never as JSON in a message.",
  );
  text = text.trim() + "\n";
  if (dir === PROMPTS) cache.set(role, text);
  return text;
}

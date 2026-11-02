// Relative links in shipped documentation resolve within the repository.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function markdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await markdown(path)));
    else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out;
}

const files = async () => [
  "README.md",
  ...(await markdown("docs")),
  ...(await markdown("examples")),
  ...(await markdown("skills")),
];

test("every relative link in the docs resolves", async () => {
  const broken: string[] = [];
  for (const file of await files()) {
    const text = await readFile(join(ROOT, file), "utf8");
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const path = join(ROOT, dirname(file), target.split("#")[0]);
      if (!existsSync(path)) broken.push(`${file}: ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

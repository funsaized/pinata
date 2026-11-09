import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const product = repository;

async function markdown(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdown(path)));
    else if (entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

test("current documentation links resolve and historical source links retain their frozen provenance", async () => {
  const inventory = JSON.parse(
    await readFile(join(product, "docs/maintainers/historical-source.json"), "utf8"),
  ) as {
    documents: Record<string, string>;
    files: Record<string, { blob: string; mode: string }>;
  };
  const files = [join(product, "README.md"), join(repository, "AGENTS.md")];
  for (const directory of ["docs", "examples", "agents", "prompts", "skills"])
    files.push(...(await markdown(join(product, directory))));
  for (const [path, expected] of Object.entries(inventory.documents)) {
    const absolute = join(repository, path);
    const bytes = await readFile(absolute);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, path);
    if (!files.includes(absolute)) files.push(absolute);
  }
  const broken: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const document = relative(repository, file).split(sep).join("/");
    for (const [, target] of content.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const absolute = resolve(dirname(file), target.split("#")[0]);
      if (existsSync(absolute)) continue;
      const historical = relative(repository, absolute).split(sep).join("/");
      if (
        Object.hasOwn(inventory.documents, document) &&
        Object.hasOwn(inventory.files, historical)
      )
        continue;
      broken.push(`${document}: ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../..", import.meta.url));

async function markdown(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdown(path)));
    else if (entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

test("published documentation links resolve in the current checkout", async () => {
  const files = [join(repository, "README.md"), join(repository, "AGENTS.md")];
  for (const directory of ["docs", "examples", "agents", "prompts", "skills"])
    files.push(...(await markdown(join(repository, directory))));
  const broken: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const [, target] of content.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const absolute = resolve(dirname(file), target.split("#")[0]);
      if (!existsSync(absolute)) broken.push(`${relative(repository, file)}: ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

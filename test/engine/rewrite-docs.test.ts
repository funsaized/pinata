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

function headingAnchors(content: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  const prose = content.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
  for (const [, heading] of prose.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const slug = heading
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\- ]/gu, "")
      .replace(/ /g, "-");
    const count = counts.get(slug) ?? 0;
    anchors.add(count ? `${slug}-${count}` : slug);
    counts.set(slug, count + 1);
  }
  return anchors;
}

test("published documentation links and heading anchors resolve in the current checkout", async () => {
  const files = [join(repository, "README.md"), join(repository, "AGENTS.md")];
  for (const directory of ["docs", "examples", "agents", "prompts", "skills"])
    files.push(...(await markdown(join(repository, directory))));
  const broken: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const [, target] of content.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [path, fragment] = target.split("#");
      const absolute = path ? resolve(dirname(file), path) : file;
      if (!existsSync(absolute)) {
        broken.push(`${relative(repository, file)}: ${target}`);
        continue;
      }
      if (fragment && absolute.endsWith(".md")) {
        const destination = absolute === file ? content : await readFile(absolute, "utf8");
        if (!headingAnchors(destination).has(decodeURIComponent(fragment)))
          broken.push(`${relative(repository, file)}: ${target}`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

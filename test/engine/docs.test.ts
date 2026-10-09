// The docs (E9.3): links resolve, commands they name exist, and shell commands the test
// suite does not run are marked _manual_.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
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

// The subcommands /pinata and the pinata command accept.
const SLASH = ["", "status", "runs", "open", "live", "watch", "mode", "rerun", "gc"];
const CLI = ["view", "logs", "run", "resume", "gc", "help"];
// Shell commands the test suite runs (by test/engine/*.test.ts, the smokes, or CI).
const TESTED = [
  /^pinata (view|logs|run|resume|gc)\b/,
  /^npm (run check|test|run bench)\b/,
  /^node (test\/engine\/(pi|package)-smoke\.ts|bench\/viewer\.ts|--test )/,
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

test("commands in the docs exist, and shell commands are tested or marked manual", async () => {
  const problems: string[] = [];
  for (const file of await files()) {
    const text = await readFile(join(ROOT, file), "utf8");
    for (const [, sub] of text.matchAll(/`\/pinata(?: ([a-z]+))?[^`]*`/g))
      if (!SLASH.includes(sub ?? "")) problems.push(`${file}: /pinata ${sub}`);
    const blocks = [...text.matchAll(/```(sh|bash)\n([\s\S]*?)```/g)];
    for (const block of blocks) {
      const before = text.slice(0, block.index).trimEnd().split("\n\n").at(-1) ?? "";
      // A page whose commands are all manual says so once.
      const manual = /_manual_/.test(before) || text.includes("Commands on this page are _manual_");
      for (const raw of block[2].split("\n")) {
        const line = raw
          .replace(/^[A-Z_]+=\S+ /g, "")
          .replace(/^([A-Z_]+=\S+ )+/, "")
          .trim();
        if (!line || line.startsWith("#")) continue;
        const cli = /^pinata ([a-z-]+)/.exec(line)?.[1];
        if (cli && !CLI.includes(cli)) problems.push(`${file}: pinata ${cli}`);
        if (!manual && !TESTED.some((r) => r.test(line)))
          problems.push(
            `${relative(ROOT, join(ROOT, file))}: untested, not marked manual: ${line}`,
          );
      }
    }
  }
  assert.deepEqual(problems, []);
});

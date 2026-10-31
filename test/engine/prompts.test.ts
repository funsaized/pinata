import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Exercise the installed Pi implementation; these helpers are not public exports.
const { loadPromptTemplates, expandPromptTemplate } = await import(
  new URL("./core/prompt-templates.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
);
const root = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const { templates, diagnostics } = loadPromptTemplates({
  cwd: root,
  agentDir: root,
  promptPaths: manifest.pi.prompts,
  includeDefaults: false,
});

test("packaged pinata-fix forwards the complete request through Pi expansion", () => {
  assert.deepEqual(diagnostics, []);
  const request = "Correct the seconds-to-milliseconds conversion in src/duration.mjs";
  const expanded = expandPromptTemplate(`/pinata-fix ${request}`, templates);
  assert.ok(expanded.includes(`requested fix: ${request}.`));
  assert.ok(expanded.includes("pinata_run"));
});

test("pinata-fix handles quoted arguments without recursively expanding their content", () => {
  const expanded = expandPromptTemplate(
    '/pinata-fix "Fix $1 and $@ in src/my file.ts" "Run npm test"',
    templates,
  );
  assert.ok(expanded.includes("requested fix: Fix $1 and $@ in src/my file.ts Run npm test."));
});

test("pinata-fix without arguments leaves no literal argument placeholder", () => {
  const expanded = expandPromptTemplate("/pinata-fix", templates);
  assert.ok(expanded.includes("requested fix: ."));
  assert.ok(!expanded.includes("${@}"));
});

for (const name of ["scout", "builder", "reviewer", "pinata-review"]) {
  test(`${name} forwards arguments through real Pi expansion`, () => {
    const request = "Inspect src/duration.mjs and its zero-delay test";
    const expanded = expandPromptTemplate(`/${name} ${request}`, templates);
    assert.ok(expanded.includes(request));
    assert.ok(!expanded.includes("${@"));
    assert.ok(!expandPromptTemplate(`/${name}`, templates).includes("${@"));
  });
}

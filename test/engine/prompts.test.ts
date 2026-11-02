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

test("declared prompt templates forward the request through Pi expansion", () => {
  assert.deepEqual(diagnostics, []);
  const request = "Inspect src/duration.mjs and its zero-delay test";
  assert.equal(templates.length, manifest.pi.prompts.length);
  for (const { name } of templates) {
    const expanded = expandPromptTemplate(`/${name} ${request}`, templates);
    assert.notEqual(expanded, `/${name} ${request}`, `${name} must expand`);
    assert.ok(expanded.includes(request), `${name} must retain the complete request`);
    assert.ok(!expanded.includes("${@"), `${name} has an unexpanded placeholder`);
    assert.ok(!expandPromptTemplate(`/${name}`, templates).includes("${@"), name);
  }
});

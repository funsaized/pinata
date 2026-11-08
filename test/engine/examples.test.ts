import { discoverAgents, readDefinition, resolveTasks } from "../../engine/pi/definitions.ts";
// The shipped examples (configs and job files) satisfy the engine's input contracts.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateChecks, validateGraph } from "../../engine/core/validate.ts";
import { jobParams, type Job } from "../../engine/headless/main.ts";
import { validateConfig } from "../../engine/pi/config.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const json = async (file: string) => JSON.parse(await readFile(join(ROOT, file), "utf8"));
const files = async (dir: string) =>
  (await readdir(join(ROOT, dir))).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));

test("example configs and job files satisfy the engine's contracts", async () => {
  for (const file of [...(await files("examples/configs")), "examples/pinata.config.json"]) {
    const { notices } = validateConfig(await json(file));
    assert.deepEqual(notices, [], `${file} uses retired keys`);
  }
  const jobs = [
    ...(await files("examples/jobs")),
    "examples/job.json",
    "examples/scout-job.json",
    "examples/tutorial-build-job.json",
    "examples/relay/job.json",
    "examples/jobs.md",
  ];
  for (const file of jobs) {
    const job: Job = file.endsWith(".md")
      ? {
          tasks: [
            ...(await readFile(join(ROOT, file), "utf8")).matchAll(/```json\n([\s\S]*?)```/g),
          ].map(([, source]) => JSON.parse(source)),
        }
      : await json(file);
    const params = jobParams(job, join(ROOT, file));
    const agents = discoverAgents(undefined, join(ROOT, "test", "absent-agent-dir"));
    for (const name of ["planner", "researcher"])
      agents.set(name, readDefinition(join(ROOT, "examples", "agents", `${name}.md`)));
    const resolved = resolveTasks(params.tasks, agents);
    assert.deepEqual(resolved.notices, [], `${file} uses deprecated task selectors`);
    const tasks = validateGraph(resolved.tasks, {
      allowWrites: true,
      definitions: resolved.definitions,
    });
    assert(tasks.length, file);
    validateConfig(params.config ?? {});
  }
});

test("documented custom agent, task graph, and configuration examples validate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pinata-doc-examples-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const guide = await readFile(join(ROOT, "docs/how-to/agents.md"), "utf8");
  const definitions = [...guide.matchAll(/```markdown\n([\s\S]*?)```/g)];
  assert.equal(definitions.length, 1, "the agent guide should provide a definition to save");
  const directory = join(root, ".pi", "pinata", "agents");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "api-scout.md"), definitions[0][1]);
  const agents = discoverAgents(root, join(root, "personal"));
  assert(agents.has("api-scout"));

  for (const file of [
    "docs/how-to/agents.md",
    "docs/how-to/customize.md",
    "docs/reference/agents.md",
    "docs/reference/config.md",
  ]) {
    const source = await readFile(join(ROOT, file), "utf8");
    const examples = [...source.matchAll(/```json\n([\s\S]*?)```/g)];
    assert(examples.length, `${file} should include a configuration or run example`);
    for (const [, text] of examples) {
      const example = JSON.parse(text);
      if (example.tasks) {
        const resolved = resolveTasks(example.tasks, agents);
        assert.deepEqual(resolved.notices, [], `${file} uses deprecated task selectors`);
        const tasks = validateGraph(resolved.tasks, {
          allowWrites: typeof example.approval === "string" && !!example.approval.trim(),
          definitions: resolved.definitions,
        });
        assert(tasks.length, file);
        validateChecks(example.integratedChecks ?? [], "integratedChecks");
        assert.deepEqual(validateConfig(example.config ?? {}).notices, [], file);
      } else {
        assert.deepEqual(validateConfig(example).notices, [], `${file} uses retired keys`);
      }
    }
  }
});

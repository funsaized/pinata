import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createWorkerResolver,
  findDefinition,
  materializeSkills,
  parseDefinitionMarkdown,
  readLoadout,
  resolveConfig,
  type WorkerResolverOptions,
} from "../../engine/definitions/index.ts";
import {
  workerRequestSchema,
  type ArtifactPort,
  type BackendCapabilities,
  type CallerAuthority,
} from "../../engine/contracts/index.ts";
import { digestBytes } from "../../engine/storage/io.ts";
import { checkResolvedWorker } from "../../engine/core/accept.ts";

const model = (id: string) => ({ provider: "fixture", id, thinking: "off" as const });
const capabilities: BackendCapabilities = {
  available: true,
  steer: true,
  continuation: true,
  conversationSeed: true,
  surviving: false,
  cleanup: "confirmed",
  skills: true,
  memory: true,
  fallbacks: true,
};
const caller: CallerAuthority = {
  id: "coordinator",
  kind: "coordinator",
  run: "run",
  grants: {
    access: "write",
    tools: ["read", "edit"],
    workspaces: ["shared", "worktree"],
    inheritContext: true,
    memory: { scope: "worker", access: "write" },
    delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
  },
};
const markdown = (header = "", body = "Follow the task.") =>
  `---\nschemaVersion: 3\nname: reader\nhandoffDescription: Read the workspace.\ntools: [read]\n${header}---\n${body}\n`;

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-definitions-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const personal = join(directory, "personal");
  const project = join(directory, "project");
  const agentDir = join(directory, "pi");
  await Promise.all([mkdir(personal), mkdir(project), mkdir(agentDir)]);
  await writeFile(join(personal, "reader.md"), markdown());
  const bytesByDigest = new Map<string, Buffer>();
  const artifacts: ArtifactPort = {
    async put(input) {
      const bytes = Buffer.from(input);
      const digest = digestBytes(bytes);
      bytesByDigest.set(digest, bytes);
      return { digest, size: bytes.length };
    },
    async read(ref) {
      const bytes = bytesByDigest.get(ref.digest);
      assert(bytes);
      return Buffer.from(bytes);
    },
  };
  const options: WorkerResolverOptions = {
    cwd: directory,
    agentDir,
    definitionDirectories: [personal, project],
    parentModel: model("parent"),
    tools: { read: { access: "read" }, edit: { access: "write" } },
    backends: { "in-process": capabilities, process: capabilities, "herdr-pi": capabilities },
    modelAvailable: () => true,
  };
  const resolve = async (overrides: Partial<WorkerResolverOptions> = {}, request: object = {}) => {
    const workers = await createWorkerResolver({ ...options, ...overrides })(
      [workerRequestSchema.parse({ id: "reader", agent: "reader", task: "Read", ...request })],
      caller,
      { putArtifact: artifacts.put },
    );
    return workers[0];
  };
  return { directory, personal, project, agentDir, artifacts, options, resolve };
}

test("definition Markdown uses a strict closed header and rejects invalid selected overrides", async (t) => {
  assert.equal(
    parseDefinitionMarkdown("\uFEFF" + markdown()).definition.instructions.trim(),
    "Follow the task.",
  );
  for (const input of [
    "No frontmatter",
    "---\nschemaVersion: 3",
    markdown("instructions: another prompt\n"),
    markdown("temperature: 0.3\n"),
    markdown("modelSettings: { reasoning: { effort: impossible } }\n"),
    markdown("pinata: { color: red }\n"),
    markdown("pinata: { unknown: true }\n"),
    markdown("---malformed\n"),
    markdown("schemaVersion: 3\n"),
  ])
    assert.throws(() => parseDefinitionMarkdown(input));
  const f = await fixture(t);
  assert.equal((await findDefinition("reader", [f.personal, f.project])).definition.name, "reader");
  await writeFile(join(f.project, "reader.md"), "bad higher-priority override");
  await assert.rejects(findDefinition("reader", [f.personal, f.project]), /frontmatter/);
  await rm(join(f.project, "reader.md"));
  await symlink(join(f.directory, "absent.md"), join(f.project, "reader.md"));
  await assert.rejects(findDefinition("reader", [f.personal, f.project]));
});

test("definition resolution freezes only the explicitly requested replacement origin", async (t) => {
  const f = await fixture(t);
  const origin = { run: caller.run, worker: "previous", assignment: 3 };
  const request = workerRequestSchema.parse({
    id: "reader",
    agent: "reader",
    task: "Read",
    origin,
  });
  const resolved = await f.resolve({}, { origin });
  assert.deepEqual(resolved.origin, origin);
  assert.equal(resolved.context, undefined);
  checkResolvedWorker(request, resolved, caller);
  assert.throws(
    () => checkResolvedWorker(request, { ...resolved, origin: undefined }, caller),
    /origin/,
  );
  assert.throws(
    () =>
      checkResolvedWorker(request, { ...resolved, origin: { ...origin, assignment: 4 } }, caller),
    /origin/,
  );
  assert.equal((await f.resolve()).origin, undefined);
});

test("configuration merges map entries while later supplied objects replace earlier objects", () => {
  const resolved = resolveConfig([
    {
      models: { default: model("default"), reader: model("personal") },
      fallbacks: { reader: [model("fallback")] },
      toolProviders: { extra: { extension: "extra.ts", tools: ["extra"] } },
      ui: { palette: "nord", keys: { quit: "q" } },
      passEnv: ["ONE"],
      workspace: "worktree",
    },
    { models: { reader: model("project") }, ui: { motion: "off" }, passEnv: ["TWO"] },
    { models: { other: model("run") }, fallbacks: { reader: [] } },
  ]);
  assert.equal(resolved.models.default.id, "default");
  assert.equal(resolved.models.reader.id, "project");
  assert.equal(resolved.models.other.id, "run");
  assert.deepEqual(resolved.fallbacks.reader, []);
  assert.equal(resolved.toolProviders.extra.extension, "extra.ts");
  assert.deepEqual(resolved.ui, { palette: "inherit", motion: "off", keys: {} });
  assert.deepEqual(resolved.passEnv, ["TWO"]);
  assert.equal(resolved.workspace, "worktree");
  assert.throws(() => resolveConfig([{ ui: { unknown: true } }]));
});

test("checkout observation is frozen only from an explicit worker request", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.resolve()).observeWorkspace, undefined);
  assert.equal((await f.resolve({}, { observeWorkspace: false })).observeWorkspace, false);
  const request = workerRequestSchema.parse({
    id: "reader",
    agent: "reader",
    task: "Read and retain a checkout observation",
    observeWorkspace: true,
  });
  const resolved = await f.resolve({}, request);
  assert.equal(resolved.observeWorkspace, true);
  assert.equal(resolved.access, "read");
  assert.equal(resolved.workspace, "shared");
  checkResolvedWorker(request, resolved, caller);
  assert.throws(
    () => checkResolvedWorker(request, { ...resolved, observeWorkspace: undefined }, caller),
    /observeWorkspace/,
  );
});

test("worker resolution freezes precedence, fallbacks and backend capabilities before launch", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.project, "reader.md"),
    markdown(
      "model: fixture/definition\nmodelSettings: { reasoning: { effort: high } }\npinata: { color: '#aabbcc', fallbacks: [{ provider: fixture, id: alternate, thinking: low }] }\n",
    ),
  );
  const config = {
    personal: { models: { default: model("default"), reader: model("personal") } },
    project: { models: { reader: model("project") } },
    run: { models: { reader: model("run") } },
  };
  assert.equal((await f.resolve({ config }, { model: model("task") })).model?.id, "task");
  assert.equal((await f.resolve({ config })).model?.id, "run");
  const resolved = await f.resolve();
  assert.equal(resolved.model?.id, "definition");
  assert.equal(resolved.model?.thinking, "high");
  assert.equal(resolved.fallbacks[0].id, "alternate");
  assert(resolved.loadout);
  assert.equal((await readLoadout(resolved.loadout, f.artifacts)).color, "#aabbcc");
  const explicitModel = model("unavailable");
  const fallback = await f.resolve(
    { modelAvailable: (candidate) => candidate.id === "alternate" },
    { model: explicitModel },
  );
  assert.equal(fallback.model?.id, "alternate");
  assert(fallback.loadout);
  assert.equal((await readLoadout(fallback.loadout, f.artifacts)).provenance.model, "fallback:1");
  const request = workerRequestSchema.parse({
    id: "reader",
    agent: "reader",
    task: "Read",
    model: explicitModel,
  });
  checkResolvedWorker(request, fallback, caller);
  assert.throws(
    () => checkResolvedWorker(request, { ...fallback, model: model("unconfigured") }, caller),
    { code: "unsupported" },
  );
  assert.deepEqual(
    (await f.resolve({ config: { run: { fallbacks: { reader: [] } } } })).fallbacks,
    [],
  );
  await assert.rejects(
    f.resolve({ backends: { "in-process": { ...capabilities, fallbacks: false } } }),
    /fallbacks/,
  );
  await assert.rejects(f.resolve({ modelAvailable: () => false }), /None of the configured models/);
  await assert.rejects(
    f.resolve(
      { backends: { "in-process": { ...capabilities, conversationSeed: false } } },
      { inheritContext: "parent" },
    ),
    /Worker reader: This backend cannot import parent context/,
  );
  await assert.rejects(f.resolve({}, { lifetime: "surviving" }), /cannot survive/);
  await writeFile(join(f.project, "reader.md"), markdown());
  assert.equal(
    (await f.resolve({ config: { run: { models: { default: model("default") } } } })).model?.id,
    "default",
  );
  assert.equal((await f.resolve()).model?.id, "parent");
});

test("explicit web provider compatibility freezes one source and refuses ambiguous registrations", async (t) => {
  const f = await fixture(t);
  const extension = join(f.directory, "web-provider.ts");
  await writeFile(extension, "export default () => {};\n");
  await writeFile(
    join(f.project, "reader.md"),
    markdown().replace("tools: [read]", "tools: [web_search]"),
  );
  const resolve = (duplicate: boolean) =>
    createWorkerResolver({
      ...f.options,
      tools: { web_search: { access: "read" } },
      config: {
        run: {
          webExtension: extension,
          ...(duplicate
            ? { toolProviders: { duplicate: { extension, tools: ["web_search"] } } }
            : {}),
        },
      },
    })(
      [workerRequestSchema.parse({ id: "reader", agent: "reader", task: "Search" })],
      {
        ...caller,
        grants: { ...caller.grants, tools: ["web_search"] },
      },
      { putArtifact: f.artifacts.put },
    );
  const [worker] = await resolve(false);
  assert(worker.loadout);
  assert.deepEqual(
    (await readLoadout(worker.loadout, f.artifacts)).providers.map((provider) => provider.path),
    [extension],
  );
  await assert.rejects(resolve(true), /Multiple configured providers/);
});

test("explicit skill snapshots retain resource bytes without broadening tools or read access", async (t) => {
  const f = await fixture(t);
  const unused = join(f.directory, "unused-resources");
  assert.deepEqual(await materializeSkills([], f.artifacts, unused), []);
  await assert.rejects(access(unused), { code: "ENOENT" });
  const skill = join(f.project, "skills", "example");
  await mkdir(join(skill, "scripts"), { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: example\ndescription: Example skill\n---\nRead scripts/example.txt.\n",
  );
  await writeFile(join(skill, "scripts", "example.txt"), "frozen resource");
  await writeFile(
    join(f.project, "reader.md"),
    markdown("pinata: { skills: [skills/example], color: accent.cyan }\n"),
  );
  const workers = await Promise.all(
    ["in-process", "process", "herdr-pi"].map((backend) => f.resolve({}, { backend })),
  );
  for (const worker of workers) {
    assert.deepEqual(worker.tools, ["read"]);
    assert.equal(worker.access, "read");
    assert(worker.loadout);
    const loadout = await readLoadout(worker.loadout, f.artifacts);
    assert.equal(loadout.skills[0].files.length, 2);
    assert.equal(loadout.color, "accent.cyan");
  }
  const frozen = workers[0];
  assert(frozen.loadout);
  const loadout = await readLoadout(frozen.loadout, f.artifacts);
  await writeFile(join(skill, "scripts", "example.txt"), "changed resource");
  const [materialized] = await materializeSkills(
    loadout.skills,
    f.artifacts,
    join(f.directory, "resolved"),
  );
  assert.equal(
    await readFile(join(dirname(materialized), "scripts", "example.txt"), "utf8"),
    "frozen resource",
  );
  const changed = await f.resolve();
  assert.notEqual(changed.loadout?.digest, frozen.loadout.digest);
  await assert.rejects(
    f.resolve({ backends: { "in-process": { ...capabilities, skills: false } } }),
    /skills/,
  );
  await writeFile(
    join(f.project, "reader.md"),
    markdown().replace("tools: [read]", "tools: [read, edit]"),
  );
  await assert.rejects(f.resolve(), /Read-only definition/);
  await writeFile(join(f.project, "reader.md"), markdown("pinata: { skills: [skills/example] }\n"));
  await symlink(join(f.directory, "missing"), join(skill, "linked"));
  await assert.rejects(f.resolve(), /traverses a link/);
});

test("batch resolution captures definitions once, deduplicates artifacts, and sees later edits", async (t) => {
  const f = await fixture(t);
  const requests = ["first", "second"].map((id) =>
    workerRequestSchema.parse({ id, agent: "reader", task: "Read" }),
  );
  const resolver = createWorkerResolver({
    ...f.options,
    freezeWorker: async (worker) => {
      if (worker.id === "first")
        await writeFile(join(f.personal, "reader.md"), markdown("", "Changed instructions."));
      return worker;
    },
  });
  const writes: string[] = [];
  const storage = {
    putArtifact: async (bytes: Uint8Array) => {
      writes.push(digestBytes(bytes));
      return f.artifacts.put(bytes);
    },
  };
  const workers = await resolver(requests, caller, storage);
  assert.deepEqual(workers[0].definition, workers[1].definition);
  assert.equal(writes.length, new Set(writes).size);
  const later = await resolver([requests[1]], caller, storage);
  assert.notDeepEqual(later[0].definition, workers[0].definition);
});

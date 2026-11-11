import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { defineAgent, openHost, type Host } from "../../engine/host/index.ts";
import { loadBootstrap, trustedOutputSchema } from "../../engine/definitions/typed.ts";
import { availableDefinitions } from "../../engine/definitions/index.ts";
import { processArtifacts } from "../../engine/backends/process-transport.ts";
import { readLoadout } from "../../engine/definitions/resources.ts";
import { definitionSchema, canonicalJson } from "../../engine/contracts/index.ts";
import { runCli } from "../../engine/headless/main.ts";

const base = {
  name: "typed",
  instructions: "Return useful ordinary text or optional typed data.",
  handoffDescription: "Typed fixture",
  tools: [],
};

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-typed-")));
  const workspace = join(directory, "workspace");
  const agentDir = join(directory, "agent");
  const definitions = join(directory, "definitions");
  await Promise.all([mkdir(workspace), mkdir(agentDir), mkdir(definitions)]);
  const module = join(directory, "bootstrap.ts");
  const records = join(directory, "requests.jsonl");
  const source = `
import { defineAgent } from ${JSON.stringify(new URL("../../engine/public.mjs", import.meta.url).href)};
import { z } from ${JSON.stringify(import.meta.resolve("zod"))};
import { installTypedProvider } from ${JSON.stringify(new URL("./fixtures/rewrite-typed-provider.ts", import.meta.url).href)};
export const agents = [defineAgent({
  ...${JSON.stringify(base)},
  model: "typed-fixture/script",
  outputType: z.strictObject({ value: z.number().int() }).refine(async (data) => data.value % 2 === 0, { message: "Expected an even fixture value" })
})];
export function configureModelRuntime(runtime) { installTypedProvider(runtime, ${JSON.stringify(records)}); }
`;
  await writeFile(module, source);
  const hosts: Host[] = [];
  t.after(async () => {
    for (const host of hosts) await host.close("Typed definition fixture complete");
    await rm(directory, { recursive: true, force: true });
  });
  const open = async (backend: "in-process" | "process") => {
    const host = await openHost({
      workspace,
      agentDir,
      directory: join(directory, "run"),
      definitionDirectories: [definitions],
      bootstrapModule: module,
      config: { run: { backend, codemode: false } },
    });
    hosts.push(host);
    return host;
  };
  return { directory, definitions, module, source, records, open };
}

for (const backend of ["in-process", "process"] as const) {
  test(
    `trusted TypeScript definitions retain async refinements and optional reports through ${backend}`,
    {
      timeout: 45_000,
      skip: backend === "process" && !["linux", "darwin"].includes(process.platform),
    },
    async (t) => {
      const world = await fixture(t);
      const host = await world.open(backend);
      const discovered = await host.runtime.query({ kind: "definitions" }, host.caller);
      assert.equal(discovered.kind, "definitions");
      if (discovered.kind !== "definitions") throw new Error("No definitions");
      assert.equal(discovered.definitions[0].definition.outputType, "trusted:typed");
      assert.equal(discovered.definitions[0].outputSchema?.type, "object");
      const accepted = await host.runtime.execute(
        {
          requestId: "typed",
          command: {
            kind: "create",
            workers: ["valid-report", "invalid-report", "plain-output"].map((id) => ({
              id,
              agent: "typed",
              task: id,
            })),
          },
        },
        host.caller,
      );
      assert.equal(accepted.status, "accepted", JSON.stringify(accepted));
      const ended = await host.runtime.wait({}, host.caller, AbortSignal.timeout(35_000));
      assert.equal(ended.status, "settled", JSON.stringify(host.runtime.diagnostics()));
      assert(
        ended.results.every(
          (result) => result.execution.phase === "ended" && result.execution.reason === "completed",
        ),
        JSON.stringify({ results: ended.results, diagnostics: host.runtime.diagnostics() }),
      );
      const artifacts = processArtifacts(host.directory);
      const valid = ended.results.find((result) => result.ref.worker === "valid-report");
      assert(valid?.report);
      assert.deepEqual(
        JSON.parse(Buffer.from(await artifacts.read(valid.report)).toString()).data,
        { value: 2 },
      );
      const invalid = ended.results.find((result) => result.ref.worker === "invalid-report");
      assert.match(invalid?.reportingError ?? "", /even fixture value/);
      assert.equal(invalid?.report, undefined);
      assert.equal(invalid?.summary, "Plain completion remains valid.");
      assert.equal(
        ended.results.find((result) => result.ref.worker === "plain-output")?.reportingError,
        undefined,
      );
      const state = await host.runtime.query({ kind: "status" }, host.caller);
      if (state.kind !== "status") throw new Error("No state");
      const worker = state.state.workers["valid-report"];
      assert(worker.loadout);
      const loadout = await readLoadout(worker.loadout, artifacts);
      assert(loadout.trusted?.outputSchema);
      assert.equal(loadout.source.path, world.module);
      const bootstrap = await loadBootstrap(world.module);
      const definition = definitionSchema.parse(
        JSON.parse(Buffer.from(await artifacts.read(worker.definition)).toString()),
      );
      await assert.rejects(
        trustedOutputSchema(undefined, loadout, definition, artifacts),
        /explicit host bootstrap/,
      );
      await assert.rejects(
        trustedOutputSchema(
          bootstrap,
          loadout,
          { ...definition, instructions: "Changed" },
          artifacts,
        ),
        /frozen descriptor/,
      );
      const wrong = await artifacts.put(Buffer.from(canonicalJson({ type: "string" })));
      await assert.rejects(
        trustedOutputSchema(
          bootstrap,
          { ...loadout, trusted: { outputSchema: wrong } },
          definition,
          artifacts,
        ),
        /frozen descriptor/,
      );
    },
  );

  test(
    `trusted bootstrap refinement-only drift is refused before ${backend} provider execution`,
    {
      timeout: 30_000,
      skip: backend === "process" && !["linux", "darwin"].includes(process.platform),
    },
    async (t) => {
      const world = await fixture(t);
      const host = await world.open(backend);
      const unsubscribe = host.runtime.subscribe({}, host.caller, (event) => {
        if (event.kind === "committed" && event.transition.kind === "accepted")
          writeFileSync(
            world.module,
            world.source.replace("data.value % 2 === 0", "data.value % 2 === 1"),
          );
      });
      const accepted = await host.runtime.execute(
        {
          requestId: "drift",
          command: {
            kind: "create",
            workers: [{ id: "drift", agent: "typed", task: "valid-report" }],
          },
        },
        host.caller,
      );
      assert.equal(accepted.status, "accepted");
      unsubscribe();
      const ended = await host.runtime.wait({}, host.caller, AbortSignal.timeout(20_000));
      assert.equal(ended.status, "settled", JSON.stringify(host.runtime.diagnostics()));
      assert.equal(
        ended.results[0].execution.phase === "ended" && ended.results[0].execution.reason,
        "failed",
      );
      await assert.rejects(readFile(world.records), { code: "ENOENT" });
      await assert.rejects(loadBootstrap(world.module), /changed.*fresh process/);
    },
  );
}

test("first trusted load uses current bytes after an earlier ordinary module import", async (t) => {
  const world = await fixture(t);
  const previous = await import(pathToFileURL(world.module).href);
  const previousSchema: unknown = previous.agents[0].outputSchema;
  assert(previousSchema instanceof z.ZodType);
  assert.equal((await previousSchema.safeParseAsync({ value: 3 })).success, false);
  await writeFile(
    world.module,
    world.source.replace("data.value % 2 === 0", "data.value % 2 === 1"),
  );
  const current = await loadBootstrap(world.module);
  const validator = current.agents.get("typed")?.outputSchema;
  assert(validator);
  assert.equal((await validator.safeParseAsync({ value: 3 })).success, true);
  assert.equal((await validator.safeParseAsync({ value: 2 })).success, false);
});

test("typed authoring and bootstrap discovery reject malformed or ambiguous definitions", async (t) => {
  assert.throws(() => defineAgent({ ...base, outputType: z.date() }), /JSON input and output/);
  assert.throws(
    () => defineAgent({ ...base, outputType: z.string().transform((text) => text.length) }),
    /JSON input and output/,
  );
  assert.throws(() => defineAgent({ ...base, name: "invalid name" }), /name/);
  const world = await fixture(t);
  await assert.rejects(loadBootstrap(join(world.directory, "absent.ts")), { code: "ENOENT" });
  for (const [name, content, expected] of [
    ["empty", "export const unrelated = true;", /configureModelRuntime or agents/],
    ["hook", "export const configureModelRuntime = 1;", /must be a function/],
    ["array", "export const agents = {};", /array/],
    ["raw", "export const agents = [{name:'typed'}];", /defineAgent results/],
    [
      "duplicate",
      world.source.replace(
        "export function configureModelRuntime",
        "agents.push(agents[0]); export function configureModelRuntime",
      ),
      /Duplicate trusted agent/,
    ],
  ] as const) {
    const path = join(world.directory, `${name}.ts`);
    await writeFile(path, content);
    await assert.rejects(loadBootstrap(path), expected);
  }
  let output = "";
  assert.equal(
    await runCli(
      [
        "agents",
        "show",
        "typed",
        "--bootstrap",
        world.module,
        "--definitions",
        world.definitions,
        "--json",
      ],
      {
        out: (text) => {
          output += text;
        },
        error: (text) => {
          throw new Error(text);
        },
        input: async () => "",
        signal: new AbortController().signal,
      },
    ),
    0,
  );
  assert.equal(JSON.parse(output).definitions[0].outputSchema.type, "object");
  await writeFile(
    join(world.definitions, "typed.md"),
    "---\nschemaVersion: 1\nname: typed\nhandoffDescription: Markdown collision\n---\nInstructions\n",
  );
  await assert.rejects(
    availableDefinitions([world.definitions], await loadBootstrap(world.module)),
    /share the name typed/,
  );
});

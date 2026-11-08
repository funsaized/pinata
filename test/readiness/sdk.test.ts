import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import type { TSchema } from "typebox";
import {
  fauxAssistantMessage,
  fauxText,
  validateToolArguments,
  type JsonObject,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxWorld } from "../engine/faux.ts";

const command = z.strictObject({
  requestId: z.string().min(1),
  operation: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("add"),
      workers: z
        .array(
          z.strictObject({
            id: z.string().min(1),
            after: z
              .array(
                z.strictObject({ worker: z.string(), assignment: z.number().int().positive() }),
              )
              .optional(),
          }),
        )
        .min(1),
    }),
    z.strictObject({
      kind: z.literal("cancel"),
      scope: z.enum(["assignment", "worker", "run"]),
      assignment: z.number().int().positive().optional(),
    }),
  ]),
});

// One explicit boundary cast, exercised against Pi's actual validator below.
const parameters = z.toJSONSchema(command, { target: "draft-07", io: "input" }) as TSchema;
const tool = { name: "readiness_command", description: "No effects", parameters };
const validate = (args: JsonObject): unknown =>
  validateToolArguments(tool, { type: "toolCall", id: "probe", name: tool.name, arguments: args });

test("Zod input schemas work through the installed Pi TypeBox validator", () => {
  const values: JsonObject[] = [
    {
      requestId: "one",
      operation: {
        kind: "add",
        workers: [{ id: "base" }, { id: "audit", after: [{ worker: "base", assignment: 1 }] }],
      },
    },
    { requestId: "two", operation: { kind: "cancel", scope: "worker" } },
  ];
  for (const value of values) assert.deepEqual(command.parse(validate(value)), value);
  const invalidValues: JsonObject[] = [
    { requestId: "one", operation: { kind: "add", workers: [] } },
    { requestId: "one", operation: { kind: "invalid" } },
    { requestId: "one", operation: { kind: "cancel", scope: "worker" }, authority: "admin" },
    { requestId: "one", operation: { kind: "cancel", scope: "assignment", assignment: -1 } },
  ];
  for (const value of invalidValues) {
    assert.equal(command.safeParse(value).success, false);
    assert.throws(() => validate(value));
  }
  assert.throws(() => z.toJSONSchema(z.string().transform((value) => value.length)));
});

test("Pi normalizes optional nulls and numbers before canonical runtime validation", (t) => {
  const raw = {
    requestId: "one",
    operation: { kind: "cancel", scope: "assignment", assignment: "2" },
  };
  assert.equal(command.safeParse(raw).success, false);
  const normalized = command.parse(validate(raw));
  assert.equal(normalized.operation.kind === "cancel" && normalized.operation.assignment, 2);
  const optional = z.strictObject({ note: z.string().optional() });
  const nullInput = { note: null };
  assert.equal(optional.safeParse(nullInput).success, false);
  const normalizedNull: unknown = validateToolArguments(
    {
      ...tool,
      parameters: z.toJSONSchema(optional, { target: "draft-07", io: "input" }) as TSchema,
    },
    { type: "toolCall", id: "null", name: tool.name, arguments: nullInput },
  );
  assert.deepEqual(optional.parse(normalizedNull), {});
  t.diagnostic(
    JSON.stringify({
      probe: "schema-bridge",
      rawWireParity: false,
      canonicalInputParity: true,
      piCoercesNumberStrings: true,
      piRemovesOptionalNull: true,
    }),
  );
});

test("schema refinements remain enforced by the canonical Zod validator", () => {
  const bounded = z
    .strictObject({ lower: z.number(), upper: z.number() })
    .refine((value) => value.lower <= value.upper, { message: "lower must not exceed upper" });
  const shape = z.toJSONSchema(bounded, { target: "draft-07", io: "input" }) as TSchema;
  const invalid = { lower: 10, upper: 1 };
  const acceptedByShape: unknown = validateToolArguments(
    { ...tool, parameters: shape },
    { type: "toolCall", id: "domain", name: tool.name, arguments: invalid },
  );
  assert.equal(bounded.safeParse(acceptedByShape).success, false);
});

test("saved branches preserve context but raw forks also copy host metadata", async (t) => {
  const world = await fauxWorld(t, () => {
    throw new Error("This probe must make no provider requests");
  });
  const parent = SessionManager.create(world.repo, join(world.dir, "parent-sessions"));
  parent.appendMessage({ role: "user", content: "Parent instruction", timestamp: 1 });
  parent.appendCustomEntry("host-control-must-not-inherit", { grant: "never copy" });
  const branch = parent.appendMessage(
    fauxAssistantMessage([fauxText("Completed parent response")]),
  );
  parent.appendMessage({ role: "user", content: "Excluded branch", timestamp: 2 });
  const selectedPath = parent.createBranchedSession(branch);
  assert(selectedPath);
  const bytes = await readFile(selectedPath, "utf8");
  const child = SessionManager.forkFrom(
    selectedPath,
    world.repo,
    join(world.dir, "child-sessions"),
  );
  const text = JSON.stringify(child.buildSessionContext().messages);
  assert.match(text, /Completed parent response/);
  assert.doesNotMatch(text, /Excluded branch/);
  assert(
    child
      .getEntries()
      .some(
        (entry) => entry.type === "custom" && entry.customType === "host-control-must-not-inherit",
      ),
  );
  child.appendMessage({ role: "user", content: "Child only", timestamp: 3 });
  assert.equal(await readFile(selectedPath, "utf8"), bytes);
  assert.equal(world.turns.length, 0);
  t.diagnostic(
    JSON.stringify({
      probe: "session-import",
      branchSelection: true,
      parentUnchanged: true,
      rawForkCopiesCustomEntries: true,
      decision: "import an allowlisted context projection, not an unfiltered file fork",
    }),
  );
});

test("explicit skills use public loader options and compaction usage remains unknown", async (t) => {
  const world = await fauxWorld(t, () => {
    throw new Error("This probe must make no provider requests");
  });
  const selected = join(world.dir, "selected/SKILL.md");
  const ambient = join(world.agentDir, "skills/ambient/SKILL.md");
  for (const [path, name] of [
    [selected, "selected"],
    [ambient, "ambient"],
  ]) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      `---\nname: ${name}\ndescription: Fixture ${name} skill\n---\nRead the fixture only.\n`,
    );
  }
  const settings = SettingsManager.create(world.repo, world.agentDir);
  const loader = new DefaultResourceLoader({
    cwd: world.repo,
    agentDir: world.agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    additionalSkillPaths: [selected],
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
  });
  await loader.reload();
  assert.deepEqual(
    loader.getSkills().skills.map((skill) => skill.name),
    ["selected"],
  );
  const manager = SessionManager.inMemory(world.repo);
  const first = manager.appendMessage({ role: "user", content: "Kept context", timestamp: 1 });
  manager.appendMessage(fauxAssistantMessage([fauxText("Earlier reply")]));
  manager.appendCompaction("Earlier conversation summary", first, 100);
  const { session } = await createAgentSession({
    cwd: world.repo,
    agentDir: world.agentDir,
    modelRuntime: await world.cache.get(world.registry),
    model: world.registry.find("faux", "faux-1"),
    tools: [],
    sessionManager: manager,
    settingsManager: settings,
    resourceLoader: loader,
  });
  t.after(() => session.dispose());
  assert.deepEqual(session.getActiveToolNames(), []);
  const usage = session.getContextUsage();
  assert(usage);
  assert.equal(usage.tokens, null);
  assert.equal(usage.percent, null);
  assert.equal(world.turns.length, 0);
  t.diagnostic(
    JSON.stringify({
      probe: "skills-context",
      selectedOnly: true,
      implicitTools: false,
      afterCompaction: usage,
      providerCalls: 0,
    }),
  );
});

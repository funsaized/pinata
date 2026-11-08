import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { createWriteTool } from "@earendil-works/pi-coding-agent";
import { frozenWorkerSchema, digestValue } from "../../rewrite/engine/contracts/index.ts";
import {
  guardToolCall,
  validateWriteTarget,
  writePathSyntaxError,
} from "../../rewrite/engine/agent/guard.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pinata-rewrite-guard-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "workspace with spaces");
  await mkdir(root);
  return { directory, root };
}

test("replacement guard rejects path aliases that Pi's actual write tool resolves elsewhere", async (t) => {
  const { directory, root } = await fixture(t);
  const outside = join(directory, "outside.txt");
  let observed: string | undefined;
  const tool = createWriteTool(root, {
    operations: {
      mkdir: async () => {},
      writeFile: async (path) => {
        observed = path;
      },
    },
  });
  const aliases = [
    { input: `@${outside}`, target: outside },
    { input: pathToFileURL(outside).href, target: outside },
    { input: "~/pinata-rewrite-guard.txt", target: join(homedir(), "pinata-rewrite-guard.txt") },
  ];
  for (const [index, alias] of aliases.entries()) {
    assert.match((await validateWriteTarget(root, root, alias.input)) ?? "", /aliases/);
    await tool.execute(`alias-${index}`, {
      path: alias.input,
      content: "scripted probe; operations do not write",
    });
    assert.equal(observed, alias.target);
  }
});

test("replacement guard rejects Unicode space aliases while preserving ordinary spaces", async (t) => {
  const { root } = await fixture(t);
  let observed: string | undefined;
  const tool = createWriteTool(root, {
    operations: {
      mkdir: async () => {},
      writeFile: async (path) => {
        observed = path;
      },
    },
  });
  const alias = "file\u00a0name.txt";
  assert.match((await validateWriteTarget(root, root, alias)) ?? "", /Unicode space/);
  await tool.execute("unicode-alias", { path: alias, content: "probe" });
  assert.equal(observed, join(root, "file name.txt"));
  assert.equal(await validateWriteTarget(root, root, "file name.txt"), null);
  assert.equal(await validateWriteTarget(root, root, "nested folder/file name.txt"), null);
});

test("replacement guard handles Windows alias grammar without rejecting native drive paths", () => {
  for (const path of ["/c/Temp/file.txt", "/mnt/c/Temp/file.txt", "/cygdrive/c/Temp/file.txt"])
    assert.match(writePathSyntaxError(path, "win32") ?? "", /shell drive alias/);
  for (const path of ["C:relative.txt", "z:folder\\file.txt"])
    assert.match(writePathSyntaxError(path, "win32") ?? "", /drive-relative/);
  for (const path of ["\\\\?\\C:\\workspace\\file.txt", "\\\\.\\pipe\\target"])
    assert.match(writePathSyntaxError(path, "win32") ?? "", /namespace paths/);
  for (const path of [
    "C:\\workspace\\file name.txt",
    "C:/workspace/file name.txt",
    "folder\\file name.txt",
    "\\\\server\\share\\file.txt",
  ])
    assert.equal(writePathSyntaxError(path, "win32"), null);
  assert.equal(writePathSyntaxError("/c/workspace/file.txt", "linux"), null);
});

test("replacement guard accepts the selected workspace alias and refuses links beneath it", async (t) => {
  const { directory, root } = await fixture(t);
  const alias = join(directory, "selected-workspace");
  const outside = join(directory, "outside");
  await mkdir(outside);
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal(await validateWriteTarget(alias, alias, "file.txt"), null);
  assert.equal(await validateWriteTarget(alias, alias, join(alias, "file.txt")), null);
  await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.match(
    (await validateWriteTarget(root, root, "linked/file.txt")) ?? "",
    /symbolic links or junctions/,
  );
  assert.match((await validateWriteTarget(root, root, "../outside/file.txt")) ?? "", /outside/);
  for (const path of [".git/config", ".GIT/HEAD", ".pinata/run.json", "nested/.Git/config"])
    assert.match((await validateWriteTarget(root, root, path)) ?? "", /metadata/);
});

test("replacement tool guard applies frozen grants to direct and nested calls", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, "a.txt"), "original");
  const grants = {
    access: "read",
    tools: ["read", "write"],
    workspaces: ["shared"],
    inheritContext: false,
    memory: { scope: "none", access: "read" },
    delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
  };
  const worker = frozenWorkerSchema.parse({
    id: "reader",
    agent: "reader",
    definition: { digest: digestValue("reader"), size: 8 },
    tools: grants.tools,
    fallbacks: [],
    access: "read",
    workspace: "shared",
    backend: "in-process",
    lifetime: "attached",
    grants,
  });
  const options = {
    worker,
    root,
    cwd: root,
    name: "write",
    input: { path: "a.txt", content: "changed" },
  };
  assert.match((await guardToolCall(options)) ?? "", /read-only/);
  assert.match((await guardToolCall({ ...options, name: "ungranted" })) ?? "", /frozen tool grant/);
  assert.equal(
    await guardToolCall({ ...options, name: "submit_result", runtimeTools: ["submit_result"] }),
    null,
  );
  assert.equal(await guardToolCall({ ...options, name: "read" }), null);
});

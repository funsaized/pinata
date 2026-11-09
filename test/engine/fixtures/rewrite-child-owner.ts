import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openHost, type Host } from "../../../engine/host/index.ts";
import { installChildProvider } from "./rewrite-child-provider.ts";

export async function openChildRecoveryHost(directory: string): Promise<Host> {
  const agentDir = join(directory, "agent");
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  installChildProvider(modelRuntime, agentDir);
  return openHost({
    workspace: join(directory, "workspace"),
    directory: join(directory, "run"),
    agentDir,
    definitionDirectories: [join(directory, "definitions")],
    modelRuntime,
    bootstrapModule: fileURLToPath(new URL("./rewrite-child-provider.ts", import.meta.url)),
    config: { run: { backend: "process", codemode: false, execution: { maxConcurrent: 2 } } },
    parentModel: { provider: "child-fixture", id: "script", thinking: "off" },
    grants: {
      access: "read",
      tools: ["read"],
      workspaces: ["shared"],
      inheritContext: false,
      memory: { scope: "none", access: "read" },
      delegation: { maxDepth: 1, agents: ["leaf"], tools: ["read"], workspaces: ["shared"] },
    },
  });
}

async function main(directory: string, lifetime: "attached" | "surviving"): Promise<void> {
  for (const name of ["workspace", "agent", "definitions"])
    await mkdir(join(directory, name), { recursive: true });
  await writeFile(
    join(directory, "definitions", "parent.md"),
    `---
schemaVersion: 3
name: parent
handoffDescription: Delegate the held recovery fixture.
tools: [read]
handoffs: [leaf]
pinata:
  access: read
  delegation: { maxDepth: 1 }
---
Delegate the requested work.
`,
  );
  await writeFile(
    join(directory, "definitions", "leaf.md"),
    `---
schemaVersion: 3
name: leaf
handoffDescription: Hold the recovery fixture until cancellation.
tools: [read]
pinata:
  access: read
---
Hold the requested fixture.
`,
  );
  const host = await openChildRecoveryHost(directory);
  const receipt = await host.runtime.execute(
    {
      requestId: "parent",
      command: {
        kind: "create",
        workers: [
          { id: "parent", agent: "parent", task: `orphan-parent-fixture:${lifetime}`, lifetime },
        ],
      },
    },
    host.caller,
  );
  if (receipt.status !== "accepted") throw new Error(JSON.stringify(receipt));
  const deadline = performance.now() + 30_000;
  for (;;) {
    const status = await host.runtime.query({ kind: "status" }, host.caller);
    if (
      status.kind === "status" &&
      Object.keys(status.state.workers).length === 2 &&
      Object.values(status.state.assignments).every((entry) => entry.execution.phase === "running")
    ) {
      try {
        await readFile(join(directory, "agent", "orphan-leaf-ready"));
        await writeFile(join(directory, "ready.json"), JSON.stringify(status.state));
        process.send?.({ phase: "ready" });
        await new Promise(() => {});
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    if (performance.now() >= deadline)
      throw new Error(`Nested recovery fixture did not become ready: ${JSON.stringify(status)}`);
    await delay(20);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, lifetime] = process.argv.slice(2);
  if (!directory || (lifetime !== "attached" && lifetime !== "surviving"))
    throw new Error("Expected nested recovery directory and lifetime");
  await main(directory, lifetime);
}

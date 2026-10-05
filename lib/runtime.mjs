import path from "node:path";
import { command, need } from "./core.mjs";
import { executable } from "./config.mjs";

// A compiled Pi host's execPath is Pi, not a JavaScript script runner.
// Probe the standalone Node from PATH by executing code before launching work.
export async function resolveNode() {
  await executable("node");
  const result = await command([
    "node",
    "--input-type=module",
    "-e",
    "console.log(JSON.stringify({ execPath: process.execPath, version: process.versions.node, bun: Boolean(process.versions.bun) }))",
  ]);
  let runtime;
  try {
    runtime = JSON.parse(result.stdout);
  } catch {
    /* A program's --version output does not prove it can execute Node scripts. */
  }
  need(
    result.code === 0 && runtime?.bun === false && /^\d+\.\d+\.\d+$/.test(runtime.version),
    "Standalone Node cannot execute scripts; install Node >=22.19.0 on PATH",
  );
  const [major, minor] = runtime.version.split(".").map(Number);
  need(
    major > 22 || (major === 22 && minor >= 19),
    "pinata requires standalone Node >=22.19.0 on PATH",
  );
  need(
    typeof runtime.execPath === "string" && path.isAbsolute(runtime.execPath),
    "Standalone Node did not report its executable path",
  );
  // Resolve through version-manager shims to the actual interpreter.
  return { node: await executable(runtime.execPath), version: `v${runtime.version}` };
}

export async function ensureNode(run) {
  if (!run.runtime?.node) {
    const runtime = await resolveNode();
    run.runtime = { node: runtime.node };
    run.versions = { ...run.versions, node: runtime.version };
  }
  need(
    typeof run.runtime.node === "string" && path.isAbsolute(run.runtime.node),
    "Invalid standalone Node path in run",
  );
  return run.runtime.node;
}

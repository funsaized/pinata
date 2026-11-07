import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { validateUnitGraph } from "../task-graph.ts";
import type { AdapterRequest, AdapterResponse } from "../types.ts";

/** Public request reader for operator-implemented external adapter commands. */
export async function readAdapterRequest(path: string): Promise<AdapterRequest> {
  const request: AdapterRequest = JSON.parse(await readFile(path, "utf8"));
  if (
    !request ||
    request.schemaVersion !== 1 ||
    typeof request.runId !== "string" ||
    typeof request.startingRevision !== "string" ||
    !["sequential", "parallel", "sequential-review", "parallel-review", "native"].includes(
      request.workflow,
    ) ||
    typeof request.cwd !== "string" ||
    !isAbsolute(request.cwd) ||
    typeof request.evidenceDir !== "string" ||
    !isAbsolute(request.evidenceDir) ||
    !request.task ||
    typeof request.task.id !== "string" ||
    !Number.isInteger(request.task.version) ||
    typeof request.task.prompt !== "string" ||
    !Array.isArray(request.task.units) ||
    !request.task.units.every(
      (unit) =>
        unit &&
        typeof unit.id === "string" &&
        typeof unit.prompt === "string" &&
        Array.isArray(unit.files) &&
        unit.files.every((file) => typeof file === "string"),
    ) ||
    !request.limits ||
    !Number.isFinite(request.limits.timeoutMs) ||
    request.limits.timeoutMs <= 0 ||
    !Number.isInteger(request.limits.maxRepairs) ||
    request.limits.maxRepairs < 0 ||
    (request.model !== null &&
      (!request.model ||
        typeof request.model.provider !== "string" ||
        typeof request.model.id !== "string" ||
        (request.model.version !== null && typeof request.model.version !== "string") ||
        !request.model.settings ||
        typeof request.model.settings !== "object" ||
        Array.isArray(request.model.settings)))
  ) {
    throw new Error("Invalid arena adapter request (expected protocol version 1)");
  }
  validateUnitGraph(request.task.units);
  return request;
}

/**
 * Call from your executable adapter wrapper. Implement actual framework invocation
 * in handler; this helper performs no model calls and makes no integration claims.
 * Reserve stdout for the response; send framework logs to stderr or evidenceDir.
 */
export async function runProtocol(
  handler: (request: AdapterRequest) => Promise<AdapterResponse>,
  argv = process.argv.slice(2),
): Promise<void> {
  try {
    if (argv.length !== 1) throw new Error("Expected one absolute request.json argument");
    if (!isAbsolute(argv[0]!)) throw new Error("The request.json argument must be absolute");
    const request = await readAdapterRequest(argv[0]!);
    const response = await handler(request);
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stderr.write(`Arena adapter failed: ${String(error)}\n`);
    process.exitCode = 1;
  }
}

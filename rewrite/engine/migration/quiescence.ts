import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { isMissing } from "../storage/io.ts";
import { type LegacyEvent, type LegacyRun } from "./codecs.ts";

import type { LegacyQuiescenceObservation } from "../contracts/history.ts";
export type { LegacyQuiescenceObservation } from "../contracts/history.ts";

async function processState(
  pid: number,
  started: string,
): Promise<NonNullable<LegacyQuiescenceObservation["owner"]>["state"]> {
  if (process.platform === "linux") {
    let text: string;
    try {
      text = await readFile(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      if (isMissing(error)) return "absent";
      throw error;
    }
    const fields = text
      .slice(text.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    if (!fields[19]) throw new Error("Legacy owner process observation is incomplete");
    if (fields[19] !== started) return "reused";
    return fields[0] === "Z" || fields[0] === "X" ? "exited" : "active";
  }
  if (process.platform === "darwin") {
    let output: string;
    try {
      output = (
        await promisify(execFile)("ps", ["-o", "stat=,lstart=", "-p", String(pid)], {
          env: { ...process.env, LC_ALL: "C" },
          timeout: 5000,
        })
      ).stdout.trim();
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        "stdout" in error &&
        String(error.stdout).trim() === ""
      )
        return "absent";
      throw error;
    }
    const fields = /^(\S+)\s+(.+)$/.exec(output);
    if (!fields) throw new Error("Legacy owner process observation is incomplete");
    if (fields[2] !== started) return "reused";
    return fields[1].startsWith("Z") ? "exited" : "active";
  }
  if (process.platform === "win32") {
    const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -eq $p) { 'absent' } else { $p.StartTime.ToFileTimeUtc().ToString() }`;
    const output = (
      await promisify(execFile)(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { timeout: 5000, windowsHide: true },
      )
    ).stdout.trim();
    if (output === "absent") return "absent";
    if (!/^\d+$/.test(output)) throw new Error("Legacy owner process observation is incomplete");
    return output === started ? "active" : "reused";
  }
  throw new Error(`Legacy process observation is unsupported on ${process.platform}`);
}

// Legacy shell/process backends did not retain a complete descendant enrollment.
// A dead group leader or old `stopped` flag cannot prove their cleanup. This local
// adapter can establish the narrower case where only built-in file operations ran
// in a dead coordinator, with no external tools, setup, or retained checkout lease.
export async function observeLegacyQuiescence(
  directory: string,
  run: LegacyRun,
  events: LegacyEvent[],
  workspaces: string[],
): Promise<{
  observation: LegacyQuiescenceObservation;
  blockers: string[];
}> {
  const observation: LegacyQuiescenceObservation = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    host: hostname(),
    platform: process.platform,
    gates: [],
    limitations: [
      "Legacy process, shell, custom-tool and setup descendants lack complete current cleanup evidence; those runs require a matching-runtime export with externally established cleanup.",
    ],
  };
  const blockers: string[] = [];
  const owner = run.resume?.owner;
  if (!owner || owner.host !== hostname())
    blockers.push(
      "A local exact legacy coordinator identity is required to establish current quiescence; remote or missing owners are unsupported.",
    );
  else {
    try {
      const state = await processState(owner.pid, owner.started);
      observation.owner = { pid: owner.pid, started: owner.started, state };
      if (state === "active")
        blockers.push(
          "The exact legacy coordinator is still active; stop it with its matching executable before import.",
        );
    } catch (error) {
      blockers.push(
        `Legacy coordinator liveness could not be established: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const data = run.resume?.data;
  const config = data?.config;
  if (
    !data ||
    data.survive === true ||
    data.backend !== "in-process" ||
    data.codemode !== false ||
    !Array.isArray(data.toolExtensions) ||
    data.toolExtensions.length ||
    (data.webExtension !== undefined && data.webExtension !== null) ||
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    config.setup !== false ||
    (config.toolProviders !== undefined &&
      (typeof config.toolProviders !== "object" ||
        config.toolProviders === null ||
        Array.isArray(config.toolProviders) ||
        Object.keys(config.toolProviders).length))
  )
    blockers.push(
      "Legacy launch configuration cannot prove that external tools, codemode, providers and setup were disabled; their descendants require separate cleanup evidence.",
    );
  const fileTools = new Set(["read", "write", "edit", "submit_result"]);
  for (const task of run.tasks) {
    const definition = task.definition ? run.definitions?.[task.definition] : undefined;
    if (
      !definition ||
      definition.tools.some((tool) => !fileTools.has(tool)) ||
      task.checks?.length ||
      task.evidenceChecks?.length ||
      (task.backend && task.backend !== "in-process")
    )
      blockers.push(
        `Worker ${task.id} could launch external activity without a complete retained process registry; current quiescence is unsupported.`,
      );
  }
  if (events.some((event) => event.t === "agent_started" && event.backend !== "in-process"))
    blockers.push(
      "Legacy process or Herdr activity has no complete descendant enrollment; a dead PID or empty historical process group is insufficient cleanup evidence.",
    );
  if (events.some((event) => event.t === "tool_start" && !fileTools.has(event.name)))
    blockers.push(
      "Legacy execution observed an external or unknown tool; its owned activity cannot be proven stopped from the historical log.",
    );
  if (events.some((event) => event.t === "check_start"))
    blockers.push(
      "Legacy checks launched external processes without complete retained descendant identities.",
    );
  try {
    if (!run.store || (await realpath(run.store)) !== directory)
      throw new Error("Historical store was moved or its canonical storage root is unavailable");
    const storageRoot = dirname(directory);
    for (const workspace of [...new Set([run.root, ...workspaces])]) {
      const root = await realpath(workspace);
      const gate = join(
        storageRoot,
        "destinations",
        createHash("sha256").update(root).digest("hex"),
      );
      const markers: string[] = [];
      let writers: string[] = [];
      try {
        const state = await lstat(gate);
        if (!state.isDirectory() || state.isSymbolicLink())
          throw new Error(`Historical gate is not a regular directory: ${gate}`);
        for (const marker of ["gate.lock", "application.json"]) {
          try {
            await lstat(join(gate, marker));
            markers.push(marker);
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        }
        try {
          const writerState = await lstat(join(gate, "writers"));
          if (!writerState.isDirectory() || writerState.isSymbolicLink())
            throw new Error(`Historical writer registry traverses a link: ${gate}`);
          writers = (await readdir(join(gate, "writers"))).sort();
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      observation.gates.push({ directory: gate, markers, writers });
      if (markers.length || writers.length)
        blockers.push(
          `Historical checkout gate retains ownership or application evidence: ${gate}. Reconcile it with its matching executable.`,
        );
    }
  } catch (error) {
    blockers.push(
      `Historical checkout exclusion could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { observation, blockers: [...new Set(blockers)] };
}

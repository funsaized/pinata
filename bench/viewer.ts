// E5.6: viewer runtime startup and memory. Starts a live run (fake backend) with its socket,
// then launches each viewer runtime under a pseudo-terminal (`script`, Linux and macOS) and
// waits for its first live snapshot and render-request readiness marker.
//   node bench/viewer.ts [--runs 5] [--out report.json]
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeBackend } from "../engine/backends/fake.ts";
import { createEngine } from "../engine/core/engine.ts";
import { RunServer } from "../engine/ipc/server.ts";
import { piCommand } from "../test/engine/pi-smoke.ts";
import { collectProvenance, reportSummary, reserveReport } from "./report.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const shellQuote = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`;

export const viewerVariants = [
  { name: "a: pi binary + viewer extension", scope: "Full Pi host and viewer extension" },
  {
    name: "b: Node + pi-coding-agent components",
    scope: "Standalone viewer using Pi coding-agent components",
  },
  {
    name: "c: Node + pi-tui only",
    scope: "Minimal TUI snapshot; does not provide the full viewer feature set",
  },
];
export interface ViewerSample {
  startupMs: number;
  rssMB: number;
}
type RecordSample = (variant: string, sample: ViewerSample) => Promise<void>;

async function measure(runs: number, record: RecordSample) {
  const dir = await mkdtemp(join(tmpdir(), "pinata-viewer-bench-"));
  const engine = createEngine({
    backends: { fake: new FakeBackend({ scout: { hang: true }, plan: { hang: true } }) },
    defaultBackend: "fake",
  });
  let handle: Awaited<ReturnType<typeof engine.run>> | undefined;
  let server: RunServer | undefined;
  try {
    await mkdir(join(dir, "agent"));
    handle = await engine.run(
      [
        { id: "scout", role: "scout", task: "t", acceptance: ["a"] },
        { id: "plan", role: "planner", task: "t", acceptance: ["a"], after: ["scout"] },
      ].map((t) => ({ ...t })),
      { cwd: dir, dir: join(dir, "run") },
    );
    // Keep the run live: the fake agents hang until the bench ends.
    const activeHandle = handle;
    server = await RunServer.start({
      run: handle.id,
      dir: handle.dir,
      source: {
        view: () => activeHandle.view(),
        subscribe: (consumer) => engine.subscribe(activeHandle.id, consumer),
        steer: async () => {},
        abort: async () => {},
        messages: async (agent) =>
          (await engine.snapshot(activeHandle.id, agent)) ?? { messages: [] },
      },
    });

    const pi = [
      ...piCommand(),
      "--no-session",
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--extension",
      join(ROOT, "engine", "viewer", "main.ts"),
    ];
    const variants: Record<string, string[]> = {
      "a: pi binary + viewer extension": pi,
      "b: Node + pi-coding-agent components": [
        process.execPath,
        join(ROOT, "bench", "viewer-runtimes.ts"),
        "b",
      ],
      "c: Node + pi-tui only": [process.execPath, join(ROOT, "bench", "viewer-runtimes.ts"), "c"],
    };

    async function once(argv: string[], i: number): Promise<{ startupMs: number; rssMB: number }> {
      const ready = join(dir, `ready-${i}.json`);
      const command = `stty cols 120 rows 40; exec ${argv.map(shellQuote).join(" ")}`;
      const script =
        process.platform === "darwin"
          ? // macOS script needs stdin that is neither a socket (Node's pipes) nor ending (an EOF
            // becomes ^D in the terminal): a shell pipe from a long sleep.
            ["sh", "-c", `sleep 86400 | script -q /dev/null sh -c ${shellQuote(command)}`]
          : ["script", "-qfec", command, "/dev/null"];
      const t0 = performance.timeOrigin + performance.now();
      const child = spawn(script[0], script.slice(1), {
        cwd: dir,
        env: {
          ...process.env,
          PINATA_VIEW: JSON.stringify({ runs: [activeHandle.dir], cwd: dir }),
          PI_CODING_AGENT_DIR: join(dir, "agent"),
          PINATA_VIEW_READY: ready,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
          PI_TELEMETRY: "0",
          TERM: "xterm-256color",
        },
        // macOS `script` calls tcgetattr on stdin: a pipe (a socket in Node) fails, /dev/null works.
        stdio: [process.platform === "darwin" ? "ignore" : "pipe", "pipe", "pipe"],
        // Its own process group, so the whole pipeline is stopped afterwards.
        detached: true,
      });
      let spawnError: Error | undefined;
      child.once("error", (error) => {
        spawnError = error;
      });
      let output = "";
      child.stdout!.on("data", (d: Buffer) => (output = (output + d).slice(-2000)));
      child.stderr!.on("data", (d: Buffer) => (output = (output + d).slice(-2000)));
      try {
        const deadline = Date.now() + 30_000;
        while (!existsSync(ready)) {
          if (spawnError) throw spawnError;
          if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline)
            throw new Error(`viewer did not start: ${output}`);
          await new Promise((r) => setTimeout(r, 5));
        }
        await new Promise((r) => setTimeout(r, 20));
        const mark = JSON.parse(await readFile(ready, "utf8"));
        if (mark.status !== "live") throw new Error(`viewer status ${mark.status}`);
        return { startupMs: mark.at - t0, rssMB: mark.rssMB };
      } finally {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }

    let n = 0;
    for (let i = 0; i < runs; i++) {
      const ordered = Object.entries(variants);
      // Rotate which variant runs first, reducing consistent startup/cache bias.
      for (const [name, argv] of [
        ...ordered.slice(i % ordered.length),
        ...ordered.slice(0, i % ordered.length),
      ]) {
        try {
          await record(name, await once(argv, n++));
        } catch (error) {
          throw new Error(
            `${name}, sample ${i + 1}/${runs}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }
    }
  } finally {
    // Failure reporting happens after measurement cleanup. Earlier samples are
    // already checkpointed by record(), including when startup or cleanup fails.
    try {
      if (handle) {
        await engine.cancel(handle.id);
        await handle.done;
      }
    } finally {
      try {
        await server?.close();
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    }
  }
}

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

export async function main(argv = process.argv.slice(2), run = measure): Promise<number> {
  let runs = 5;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== "--runs" && flag !== "--out") throw new Error(`Unknown option: ${flag}`);
    const value = argv[++i];
    if (!value) throw new Error(`${flag} needs a value`);
    if (flag === "--runs") runs = Number(value);
    else out = value;
  }
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  const meta = await collectProvenance(ROOT, {
    kind: "viewer",
    provider: "fake",
    host: "pty",
    backend: "fake",
    mode: "viewer",
    scenarios: viewerVariants.map((variant) => variant.name),
    workload: { variants: viewerVariants, runs },
    argv,
  });
  const output = await reserveReport(ROOT, meta, out);
  const rawSamples: Record<string, ViewerSample[]> = Object.fromEntries(
    viewerVariants.map((variant) => [variant.name, []]),
  );
  const report = {
    schemaVersion: 1,
    meta: {
      ...meta,
      scope:
        "Viewer startup to first live snapshot received and render requested (not confirmed screen paint), plus runtime RSS; variants have different feature sets",
      runs,
      variants: viewerVariants,
    },
    output: { json: output.path, summary: output.summaryPath },
    os: process.platform,
    results: {} as Record<string, { startupMs: number; rssMB: number; samples: number }>,
    rawSamples,
    progress: { state: "running", completedAt: null as string | null },
    diagnostics: [] as Array<{ message: string; stack?: string }>,
    validation: null as { passed: boolean; failures: string[]; skipped?: string } | null,
  };
  const checkpoint = () =>
    output.write(
      report,
      reportSummary(meta, {
        title: "Viewer benchmark",
        status: report.validation?.skipped
          ? "SKIPPED"
          : report.validation
            ? report.validation.passed
              ? "PASS"
              : "FAIL"
            : "IN PROGRESS",
        policy:
          "Advisory measurements; no performance thresholds. Variants have different feature sets and are not equivalent user experiences. All requested samples must complete with finite, nonnegative measurements.",
        columns: ["Variant", "Feature scope", "Median startup ms", "Median RSS MiB", "Samples"],
        rows: viewerVariants.map((variant) => {
          const result = report.results[variant.name];
          return [
            variant.name,
            variant.scope,
            result?.startupMs ?? "unavailable",
            result?.rssMB ?? "unavailable",
            `${result?.samples ?? 0} / ${runs}`,
          ];
        }),
        failures: report.validation?.failures,
      }),
    );
  try {
    await checkpoint();
    console.log(`benchmark report: ${output.path}`);
    if (process.platform === "win32") {
      report.validation = {
        passed: true,
        failures: [],
        skipped: "no pseudo-terminal (script) on Windows",
      };
    } else {
      const failures: string[] = [];
      try {
        await run(runs, async (variant, sample) => {
          if (!Object.hasOwn(rawSamples, variant))
            throw new Error(`Unknown viewer variant: ${variant}`);
          if (rawSamples[variant].length >= runs)
            throw new Error(`Too many samples for ${variant}`);
          if (
            ![sample.startupMs, sample.rssMB].every((value) => Number.isFinite(value) && value >= 0)
          )
            throw new Error(`Invalid viewer measurement for ${variant}`);
          rawSamples[variant].push(structuredClone(sample));
          report.results[variant] = {
            startupMs: Math.round(median(rawSamples[variant].map((s) => s.startupMs))),
            rssMB: Math.round(median(rawSamples[variant].map((s) => s.rssMB))),
            samples: rawSamples[variant].length,
          };
          await checkpoint();
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.diagnostics.push({
          message,
          stack: error instanceof Error ? error.stack?.slice(-16_000) : undefined,
        });
        failures.push(message);
      }
      for (const variant of viewerVariants)
        if (rawSamples[variant.name].length !== runs)
          failures.push(
            `${variant.name}: measured ${rawSamples[variant.name].length}/${runs} samples`,
          );
      report.validation = { passed: failures.length === 0, failures };
    }
    report.progress = {
      state: report.validation.skipped
        ? "skipped"
        : report.validation.passed
          ? "completed"
          : "failed",
      completedAt: new Date().toISOString(),
    };
    await checkpoint();
    console.log(JSON.stringify(report, null, 2));
    console.log(`wrote ${output.path} and ${output.summaryPath}`);
    return report.validation.passed ? 0 : 1;
  } finally {
    await output.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = await main();

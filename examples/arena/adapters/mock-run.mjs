// Runs actual installed CLIs against a separate, isolated scripted provider. No
// provider credentials or external model network route enter these containers.
import { readFile, writeFile, cp, chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { runArena, root, manifest } from "../runner.ts";
import { dockerCommand, localImage } from "../sandbox.ts";
const { values } = parseArgs({
  options: {
    "image-file": { type: "string", default: "/tmp/pinata-arena-adapter-image.json" },
    out: { type: "string" },
    stack: { type: "string" },
  },
});
if (!values.out) throw Error("--out fresh-directory is required");
const artifact = JSON.parse(await readFile(values["image-file"], "utf8"));
const image = await localImage(artifact.image);
await dockerCommand([
  "run",
  "--rm",
  "--pull=never",
  "--network=none",
  "--read-only",
  "--user=65534:65534",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  image,
  "node",
  "-e",
  "const fs=require('node:fs');for(const p of ['/provider','/opt/arena-adapters/mock-provider.mjs','/opt/pinata/examples','/opt/pinata/test'])if(fs.existsSync(p))throw Error('Private fixture/grader path in contestant image: '+p)",
]);
const base = await localImage(manifest.verifierImage);
const network = `pinata-arena-mock-${randomUUID()}`;
const name = `pinata-arena-provider-${randomUUID()}`;
const temp = await mkdtemp(join(tmpdir(), "pinata-arena-mock-"));
await chmod(temp, 0o755);
const here = fileURLToPath(new URL("./", import.meta.url));
for (const [from, to] of [
  [join(here, "mock-provider.mjs"), "mock-provider.mjs"],
  [join(root, "fixtures.ts"), "fixtures.ts"],
]) {
  await cp(from, join(temp, to));
  await chmod(join(temp, to), 0o444);
}
const controller = new AbortController();
process.once("SIGINT", () => controller.abort("cancelled"));
process.once("SIGTERM", () => controller.abort("cancelled"));
await dockerCommand(["network", "create", "--internal", network]);
try {
  await dockerCommand([
    "run",
    "--detach",
    "--pull=never",
    "--rm",
    "--name",
    name,
    "--network",
    network,
    "--network-alias",
    "mock-provider",
    "--read-only",
    "--user",
    "65534:65534",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--memory=128m",
    "--pids-limit=32",
    "--mount",
    `type=bind,src=${temp},dst=/provider,readonly`,
    base,
    "node",
    "/provider/mock-provider.mjs",
  ]);
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      await dockerCommand([
        "exec",
        name,
        "node",
        "-e",
        "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)})",
      ]);
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!ready) throw Error("Mock provider did not start");
  const stacks = values.stack ? [values.stack] : ["pinata", "opencode", "pi-example"];
  if (stacks.some((s) => !["pinata", "opencode", "pi-example"].includes(s)))
    throw Error("Invalid stack");
  const live = {
    track: "controlled-same-model",
    model: { provider: "arena", id: "arena-model" },
    task: join(root, "task"),
    trials: 1,
    seed: 7,
    contestants: stacks.map((id) => ({
      id,
      name: manifest.contestants.find((c) => c.id === id)?.name ?? id,
      image,
      command: ["node", "/opt/arena-adapters/run.mjs", id],
      version:
        id === "opencode"
          ? "OpenCode 2.2.5"
          : id === "pinata"
            ? "patched Piñata 2.0.1 + Pi 1.4.0"
            : "Pi 1.4.0 official subagent example",
      source: JSON.stringify({
        pins: artifact.pins,
        sources: artifact.sources,
        pinataSources: artifact.pinataSources,
        sourceCommit: artifact.sourceCommit,
        sourceDirty: artifact.sourceDirty,
      }),
      network,
      secrets: [],
      settings: {
        mock: true,
        baseUrl: `http://mock-provider:8080/${id}/v1`,
        thinking: "off",
        memoryMb: 1024,
        pricing: {
          input: 1,
          output: 1,
          cacheRead: 1,
          cacheWrite: 1,
          reference: "Synthetic offline fixture rates",
          at: "2026-10-31T00:00:00Z",
        },
      },
    })),
  };
  const result = await runArena({
    mode: "mock",
    live,
    out: values.out,
    signal: controller.signal,
    limits: { generationMs: 120000, costUsd: 1, verificationMs: 10000, outputBytes: 1048576 },
  });
  const stats = JSON.parse(
    await dockerCommand([
      "exec",
      name,
      "node",
      "-e",
      "fetch('http://127.0.0.1:8080/stats').then(r=>r.text()).then(t=>process.stdout.write(t))",
    ]),
  );
  const audit = result.trials.map((t) => ({
    contestant: t.contestant,
    requests: stats.filter((s) => s.stack === t.contestant).length,
    providerTokens: stats.filter((s) => s.stack === t.contestant).length * 120,
    ledgerTokens: t.ledger.totals.totalTokens,
    quality: t.quality?.success ?? false,
    status: t.status,
    sessions: t.ledger.sessions.map((s) => ({
      role: s.role,
      model: s.model,
      status: s.status,
      complete: s.usageComplete,
    })),
  }));
  await writeFile(
    join(values.out, "provider-audit.json"),
    JSON.stringify(
      {
        notice: "Test-only mock request counts, not real model performance or provider billing",
        audit,
        stats,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(audit, null, 2));
  if (
    audit.some(
      (a) =>
        a.status !== "completed" ||
        !a.quality ||
        a.providerTokens !== a.ledgerTokens ||
        a.sessions.length < 2,
    )
  )
    process.exitCode = 1;
} finally {
  await dockerCommand(["rm", "--force", name]).catch(() => {});
  await dockerCommand(["network", "rm", network]).catch(() => {});
  await rm(temp, { recursive: true, force: true });
}

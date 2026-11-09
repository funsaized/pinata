// Real native Pi -> default Node worker and available Herdr monitor; no paid calls.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { piCommand, record, rpc } from "./rewrite-smoke-rpc.ts";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const directory = process.env.PINATA_NATIVE_BACKEND_DIRECTORY
  ? resolve(process.env.PINATA_NATIVE_BACKEND_DIRECTORY)
  : await mkdtemp(join(tmpdir(), "pinata-native-backend-"));
await mkdir(directory, { recursive: true });
const agentDir = join(directory, "coordinator-agent");
await mkdir(agentDir);
await writeFile(
  join(agentDir, "settings.json"),
  JSON.stringify({ quietStartup: true, retry: { enabled: false } }),
);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  PINATA_NATIVE_BACKEND_DIRECTORY: directory,
};
delete env.PINATA_AGENT;
const pi = rpc(
  [
    ...piCommand(),
    "--mode",
    "rpc",
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session",
    join(directory, "parent.jsonl"),
    "--extension",
    join(root, "test/engine/fixtures/rewrite-native-backend-extension.ts"),
    "--provider",
    "native-backend-fixture",
    "--model",
    "script",
    "--thinking",
    "off",
  ],
  { cwd: directory, env },
);
try {
  const id = pi.send({ type: "get_commands" });
  const commands = await pi.wait((event) => event.type === "response" && event.id === id);
  assert(
    JSON.stringify(record(commands.data).commands).includes("pinata-native-backends"),
    JSON.stringify(commands),
  );
  const request = pi.send({ type: "prompt", message: "/pinata-native-backends" });
  const response = await pi.wait(
    (event) => event.type === "response" && event.id === request,
    0,
    120_000,
  );
  assert.equal(response.success, true, JSON.stringify(response));
  await pi.wait(
    (event) =>
      event.type === "message_end" &&
      JSON.stringify(event.message).includes("pinata.native-backend-smoke.result"),
    0,
    120_000,
  );
  const report = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
  assert.equal(report.ok, true, JSON.stringify(report));
  assert(
    !pi.records.some((event) => event.type === "agent_start"),
    "Coordinator unexpectedly called a provider",
  );
  console.log(JSON.stringify({ ...report, directory, provider: "scripted", retained: true }));
} finally {
  await pi.close();
}

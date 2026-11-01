import { cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
const here = fileURLToPath(new URL("./", import.meta.url));
const repo = resolve(here, "../../..");
const pins = JSON.parse(await readFile(join(here, "versions.json"), "utf8"));
const { values } = parseArgs({
  options: {
    archive: { type: "string" },
    out: { type: "string", default: "/tmp/pinata-arena-adapter-image.json" },
  },
});
if (process.platform !== "linux" || process.arch !== "x64")
  throw Error("Bundled OpenCode binary setup currently supports Linux x64 only");
const context = await mkdtemp(join(tmpdir(), "pinata-arena-image-"));
const run = (cmd, args, opts = {}) => {
  const p = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (p.status !== 0) throw Error(`${cmd} failed (${p.status ?? p.error?.message})`);
};
const env = { ...process.env };
for (const k of [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
])
  delete env[k];
env.BUILDX_CONFIG = join(context, "buildx-state");
try {
  await writeFile(join(context, ".dockerignore"), "buildx-state\n");
  const archive = values.archive ? resolve(values.archive) : join(context, "opencode.tar.gz");
  if (!values.archive)
    run("curl", ["--fail", "--location", "--max-time", "180", pins.opencode.url, "-o", archive]);
  if (
    createHash("sha256")
      .update(await readFile(archive))
      .digest("hex") !== pins.opencode.sha256
  )
    throw Error("OpenCode release checksum mismatch");
  const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  if (listing.status !== 0 || listing.stdout.trim() !== "opencode")
    throw Error("Unexpected release archive layout");
  run("tar", ["-xzf", archive, "-C", context, "opencode"]);
  await cp(join(here, "Dockerfile"), join(context, "Dockerfile"));
  await mkdir(join(context, "runtime"));
  for (const f of ["package.json", "package-lock.json"])
    await cp(join(here, "runtime", f), join(context, "runtime", f));
  await mkdir(join(context, "pinata"));
  for (const f of ["engine", "agents", "skills", "prompts", "package.json", "README.md", "LICENSE"])
    await cp(join(repo, f), join(context, "pinata", f), { recursive: true });
  await mkdir(join(context, "adapters"));
  for (const f of [
    "run.mjs",
    "telemetry.mjs",
    "normalize.mjs",
    "provider-proxy.mjs",
    "versions.json",
  ])
    await cp(join(here, f), join(context, "adapters", f));
  const args = [
    "--host=unix:///var/run/docker.sock",
    "build",
    "--tag",
    "pinata-arena-adapters:local",
  ];
  if (process.env.CODEX_PROXY_CERT)
    args.push("--secret", `id=proxy_ca,src=${process.env.CODEX_PROXY_CERT}`);
  args.push(context);
  run("docker", args, { env });
  const inspected = spawnSync(
    "docker",
    [
      "--host=unix:///var/run/docker.sock",
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      "pinata-arena-adapters:local",
    ],
    { env, encoding: "utf8" },
  );
  if (inspected.status !== 0 || !/^sha256:[a-f0-9]{64}$/.test(inspected.stdout.trim()))
    throw Error("Could not pin built image");
  const sources = Object.fromEntries(
    await Promise.all(
      [
        "run.mjs",
        "normalize.mjs",
        "provider-proxy.mjs",
        "telemetry.mjs",
        "Dockerfile",
        "versions.json",
        "runtime/package-lock.json",
      ].map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(join(here, file)))
          .digest("hex"),
      ]),
    ),
  );
  const pinataSources = {};
  async function fingerprint(dir, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name),
        key = prefix + entry.name;
      if (entry.isDirectory()) await fingerprint(path, key + "/");
      else if (entry.isFile())
        pinataSources[key] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      else throw Error("Unexpected symlink in adapter source");
    }
  }
  await fingerprint(join(context, "pinata"));
  const output = {
    schema: 1,
    sources,
    pinataSources,
    sourceDirty:
      spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout.trim()
        .length > 0,
    image: inspected.stdout.trim(),
    pins,
    sourceCommit: spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim(),
  };
  await writeFile(values.out, JSON.stringify(output, null, 2) + "\n");
  console.log(`Adapter image recorded in ${values.out}: ${output.image}`);
} finally {
  await rm(context, { recursive: true, force: true });
}

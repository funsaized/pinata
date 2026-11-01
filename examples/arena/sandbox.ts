import { spawn } from "node:child_process";
import { X509Certificate, randomUUID } from "node:crypto";
import { realpath, readFile, stat, mkdtemp, chmod, writeFile, rm } from "node:fs/promises";

import { tmpdir } from "node:os";
import { join } from "node:path";

// Always select the local daemon. Never inherit a remote DOCKER_HOST/context.
const dockerEnv = () => {
  const env = { ...process.env };
  for (const name of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ])
    delete env[name];
  return env;
};
export type SandboxRequest = {
  image: string;
  command: string[];
  workspace: string;
  inputDir: string;
  writable?: boolean;
  memoryMb?: number;
  caFile?: string;
  stdin?: string;
  timeoutMs: number;
  outputBytes: number;
  signal?: AbortSignal;
  network?: string;
  secrets?: string[];
  onLine?: (line: string) => void;
};
export type ProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  reason?: string;
};
function invoke(args: string[], env = dockerEnv()) {
  return spawn("docker", ["--host=unix:///var/run/docker.sock", ...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}
export async function dockerCommand(args: string[], timeoutMs = 15000): Promise<string> {
  const p = invoke(args);
  let out = "";
  let err = "";
  let bytes = 0;
  const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  try {
    const collect = (data: Buffer, stderr: boolean) => {
      bytes += data.length;
      if (bytes > 2097152) {
        p.kill("SIGKILL");
        return;
      }
      if (stderr) err += data.toString();
      else out += data.toString();
    };
    p.stdout.on("data", (data: Buffer) => collect(data, false));
    p.stderr.on("data", (data: Buffer) => collect(data, true));
    await new Promise<void>((resolve, reject) => {
      p.once("error", reject);
      p.once("close", (code, signal) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                `Docker command failed (${args[0]}, ${signal ?? code}): ${err.trim().slice(-2000)}`,
              ),
            ),
      );
    });
    return out.trim();
  } finally {
    clearTimeout(timer);
  }
}
export async function localImage(image: string): Promise<string> {
  if (!/^(?:[a-z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("An immutable image digest is required");
  const id = await dockerCommand(["image", "inspect", "--format", "{{.Id}}", image]);
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error("Invalid local image identity");
  return id;
}
export async function sandbox(request: SandboxRequest): Promise<ProcessResult> {
  if (!/^sha256:[a-f0-9]{64}$/.test(request.image))
    throw new Error("Sandbox requires a resolved immutable local image id");
  if (
    request.memoryMb !== undefined &&
    (!Number.isInteger(request.memoryMb) || request.memoryMb < 256 || request.memoryMb > 2048)
  )
    throw new Error("Invalid container memory limit");
  if (request.network && !["none", "bridge"].includes(request.network)) {
    if (
      !/^pinata-arena-mock-[a-f0-9-]+$/.test(request.network) ||
      (await dockerCommand([
        "network",
        "inspect",
        "--format",
        "{{.Internal}}",
        request.network,
      ])) !== "true"
    )
      throw new Error("Custom networks must be isolated arena mock networks");
  }
  const work = await realpath(request.workspace);
  const input = await realpath(request.inputDir);
  if ([work, input].some((p) => p.includes(",") || p.includes("\n")))
    throw new Error("Unsupported mount path");
  let caFile: string | undefined;
  let caContents: string | undefined;
  let caDir: string | undefined;
  if (request.caFile) {
    caFile = await realpath(request.caFile);
    if (caFile.includes(",") || caFile.includes("\n") || (await stat(caFile)).size > 1048576)
      throw new Error("Invalid CA bundle");
    const pem = await readFile(caFile, "utf8");
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    if (
      !blocks.length ||
      pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()
    )
      throw new Error("Only public PEM certificates may be mounted");
    for (const block of blocks) new X509Certificate(block);
    caContents = pem;
  }
  const name = `pinata-arena-${randomUUID()}`;
  const env = dockerEnv();
  const secrets = request.secrets ?? [];
  for (const name of secrets)
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || env[name] === undefined)
      throw new Error(`Missing or invalid credential variable ${name}`);
  if (caContents) {
    // A certificate can be public while its source file is mode 0600. Stage only
    // the validated PEM so the unprivileged contestant never needs host uid access.
    caDir = await mkdtemp(join(tmpdir(), "pinata-arena-ca-"));
    await chmod(caDir, 0o755);
    caFile = join(caDir, "ca.pem");
    await writeFile(caFile, caContents, { mode: 0o444 });
    await chmod(caFile, 0o444);
  }
  const args = [
    "run",
    "--rm",
    "--pull=never",
    "--name",
    name,
    "--network",
    request.network ?? "none",
    "--read-only",
    "--user",
    "65534:65534",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=64",
    `--memory=${request.memoryMb ?? 256}m`,
    `--memory-swap=${request.memoryMb ?? 256}m`,
    "--cpus=1",
    "--ulimit",
    "nofile=256:256",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m,mode=1777",
    "--tmpfs",
    "/runtime:rw,nosuid,nodev,size=256m,mode=1777",
    "--mount",
    `type=bind,src=${work},dst=/work${request.writable ? "" : ",readonly"}`,
    "--mount",
    `type=bind,src=${input},dst=/arena,readonly`,
    "--workdir",
    "/work",
    "-e",
    "HOME=/tmp",
    ...(caFile
      ? [
          "--mount",
          `type=bind,src=${caFile},dst=/run/arena-ca.pem,readonly`,
          "-e",
          "NODE_EXTRA_CA_CERTS=/run/arena-ca.pem",
        ]
      : []),
    ...secrets.flatMap((key) => ["-e", key]),
    "-i",
    request.image,
    ...request.command,
  ];
  const p = invoke(args, env);
  let stdout = "";
  let stderr = "";
  let pending = "";
  let bytes = 0;
  let reason: string | undefined;
  let removal: Promise<unknown> | undefined;
  const stop = (why: string) => {
    reason ??= why;
    // Removing the container kills all children and prevents writes before final freeze.
    removal ??= dockerCommand(["rm", "--force", name]).catch(() => {});
    p.kill("SIGTERM");
  };
  const abort = () => stop(String(request.signal?.reason ?? "cancelled"));
  const timer = setTimeout(() => stop("timeout"), request.timeoutMs);
  request.signal?.addEventListener("abort", abort, { once: true });
  if (request.signal?.aborted) abort();
  p.stdout.on("data", (data: Buffer) => {
    bytes += data.length;
    if (bytes > request.outputBytes) return stop("output limit");
    stdout += data.toString();
    pending += data.toString();
    let i: number;
    while ((i = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, i);
      pending = pending.slice(i + 1);
      try {
        if (line.trim()) request.onLine?.(line);
      } catch (error) {
        stop(`protocol: ${(error as Error).message}`);
      }
    }
  });
  p.stderr.on("data", (data: Buffer) => {
    bytes += data.length;
    if (bytes > request.outputBytes) stop("output limit");
    else stderr += data.toString();
  });
  p.stdin.on("error", () => {});
  p.stdin.end(request.stdin ?? "");
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      p.once("error", reject);
      p.once("close", resolve);
    });
    if (pending.trim() && request.onLine && !reason) {
      try {
        request.onLine(pending);
      } catch (error) {
        reason = `protocol: ${(error as Error).message}`;
      }
    }
    return { code, stdout, stderr, ...(reason && { reason }) };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", abort);
    await removal;
    // Also cover Docker CLI failures, early abort/start races and missing --rm cleanup.
    await dockerCommand(["rm", "--force", name]).catch(() => {});
    const remains = await dockerCommand([
      "ps",
      "--all",
      "--filter",
      `name=^/${name}$`,
      "--format",
      "{{.ID}}",
    ]);
    if (caDir) await rm(caDir, { recursive: true, force: true });
    // eslint-disable-next-line no-unsafe-finally -- refusing an uncertain freeze is intentional.
    if (remains) throw new Error(`Container cleanup uncertain: ${name}; refusing final freeze`);
  }
}

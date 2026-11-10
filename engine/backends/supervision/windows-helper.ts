import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { processIdentitySchema, type ProcessIdentity } from "./contracts.ts";

const executeFile = promisify(execFile);
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const buildSchema = z.strictObject({
  source: z.string(),
  compiler: z.string(),
  executable: z.string(),
});
let prepared: Promise<string> | undefined;

async function buildHelper(): Promise<string> {
  if (process.platform !== "win32") throw new Error("Windows Job Objects require Windows");
  const source = fileURLToPath(new URL("./PinataJobLauncher.cs", import.meta.url));
  const sourceDigest = digest(await readFile(source));
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  let compiler: string | undefined;
  for (const framework of ["Framework64", "Framework"]) {
    const candidate = join(windows, "Microsoft.NET", framework, "v4.0.30319", "csc.exe");
    try {
      await access(candidate);
      compiler = candidate;
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  if (!compiler) throw new Error("Pinata requires the Windows .NET Framework 4 C# compiler");
  const compilerDigest = digest(await readFile(compiler));
  const key = digest(`${sourceDigest}/${compilerDigest}/${process.arch}/v1`);
  const root = join(
    process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
    "Pinata",
    "job-launcher",
  );
  const directory = join(root, key);
  const executable = join(directory, "PinataJobLauncher.exe");
  async function verify(): Promise<string> {
    const receipt = buildSchema.parse(
      JSON.parse(await readFile(join(directory, "build.json"), "utf8")),
    );
    if (
      receipt.source !== sourceDigest ||
      receipt.compiler !== compilerDigest ||
      receipt.executable !== digest(await readFile(executable))
    )
      throw new Error(
        "Windows helper cache differs from its build receipt; remove the cache and rebuild",
      );
    return executable;
  }
  try {
    return await verify();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(join(root, ".build-"));
  try {
    const output = join(staging, "PinataJobLauncher.exe");
    await executeFile(
      compiler,
      [
        "/noconfig",
        "/nologo",
        "/target:exe",
        "/platform:anycpu",
        "/optimize+",
        "/langversion:5",
        ...["mscorlib", "System", "System.Core", "System.Web.Extensions"].map(
          (name) => `/reference:${join(dirname(compiler), `${name}.dll`)}`,
        ),
        `/out:${output}`,
        source,
      ],
      { cwd: staging, timeout: 60_000, windowsHide: true },
    );
    await writeFile(
      join(staging, "build.json"),
      JSON.stringify({
        source: sourceDigest,
        compiler: compilerDigest,
        executable: digest(await readFile(output)),
      }) + "\n",
      { flag: "wx" },
    );
    try {
      await rename(staging, directory);
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          ["EEXIST", "ENOTEMPTY", "EPERM"].includes(String(error.code))
        )
      )
        throw error;
      // A concurrent builder may have published first. It must pass the same verification.
    }
    return await verify();
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function windowsHelperExecutable(): Promise<string> {
  prepared ??= buildHelper().catch((error: unknown) => {
    prepared = undefined;
    throw error;
  });
  return prepared;
}

export async function observeWindowsProcess(pid: number): Promise<ProcessIdentity | undefined> {
  const executable = await windowsHelperExecutable();
  const { stdout } = await executeFile(executable, ["observe", String(pid)], {
    timeout: 5000,
    windowsHide: true,
  });
  return (
    z.strictObject({ process: processIdentitySchema.nullable() }).parse(JSON.parse(stdout))
      .process ?? undefined
  );
}

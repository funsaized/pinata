import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = "3.26.0";
const binaryDirectory = join(root, ".vale", "bin", version);
const binary = join(binaryDirectory, process.platform === "win32" ? "vale.exe" : "vale");

function run(command, args, capture = false, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}: ${result.stderr ?? ""}`);
  }
  return result.stdout ?? "";
}

export function isDocumentation(path, agents = false) {
  if (!path.endsWith(".md")) return false;
  if (/^(agents|prompts|skills|examples\/agents)\//.test(path)) return agents;
  if (["AGENTS.md", "STYLE.md"].includes(path)) return agents;
  if (agents) return false;
  if (path === "README.md" || path === "arena/README.md") return true;
  if (path.startsWith("docs/")) {
    return !/^docs\/(reference\/generated\.md|maintainers\/(history|rewrite-[^/]+)\.md)$/.test(
      path,
    );
  }
  return (
    path.startsWith("examples/") && !/^examples\/relay\/(expected-report\.md|starter\/)/.test(path)
  );
}

export function selectFiles({ changed = false, base, agents = false, directory = root } = {}) {
  const tracked = run("git", ["ls-files", "-z"], true, directory).split("\0");
  const untracked = run(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    true,
    directory,
  ).split("\0");
  let candidates = [...tracked, ...untracked];
  if (changed) {
    const revision = base
      ? run("git", ["merge-base", "HEAD", base], true, directory).trim()
      : "HEAD";
    candidates = [
      ...run(
        "git",
        ["diff", "--name-only", "--diff-filter=ACMRT", "-z", revision, "--"],
        true,
        directory,
      ).split("\0"),
      ...untracked,
    ];
  }
  return [...new Set(candidates)]
    .filter((path) => isDocumentation(path, agents) && existsSync(join(directory, path)))
    .sort();
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function setup() {
  const os = { linux: "Linux", darwin: "macOS", win32: "Windows" }[process.platform];
  const arch = { x64: "64-bit", arm64: "arm64" }[process.arch];
  if (!os || !arch)
    throw new Error(`Unsupported Vale platform: ${process.platform}/${process.arch}`);
  const asset = `vale_${version}_${os}_${arch}.${os === "Windows" ? "zip" : "tar.gz"}`;
  const url = `https://github.com/vale-cli/vale/releases/download/v${version}`;
  const sums = (await download(`${url}/vale_${version}_checksums.txt`)).toString("utf8");
  const expected = sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0];
  const archive = await download(`${url}/${asset}`);
  if (!expected || createHash("sha256").update(archive).digest("hex") !== expected) {
    throw new Error(`Checksum mismatch for ${asset}`);
  }
  await mkdir(binaryDirectory, { recursive: true });
  const archivePath = join(binaryDirectory, asset);
  await writeFile(archivePath, archive);
  const tar =
    process.platform === "win32"
      ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "tar";
  run(tar, ["-xf", archivePath, "-C", binaryDirectory]);
  run(binary, ["--no-global", "--config=.vale.ini", "sync"]);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "setup") return setup();
  const options = { changed: false, agents: false, base: undefined };
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--changed") options.changed = true;
    else if (argument === "--agents") options.agents = true;
    else if (argument === "--json") json = true;
    else if (argument === "--base" && args[index + 1] && !args[index + 1].startsWith("-"))
      options.base = args[++index];
    else throw new Error(`Unknown or incomplete option: ${argument}`);
  }
  if (options.base && !options.changed) throw new Error("--base requires --changed");
  if (!existsSync(binary)) throw new Error("Run npm run docs:setup before linting prose.");
  if (!run(binary, ["--version"], true).includes(version))
    throw new Error("Unexpected Vale version; run npm run docs:setup.");
  const files = selectFiles(options);
  if (!files.length) {
    console.log(json ? "{}" : "No matching documentation files.");
    return;
  }
  const flags = ["--no-global", "--config=.vale.ini", "--no-exit", "--output=JSON"];
  // Batch paths to stay below Windows' command-line limit.
  const reports = {};
  for (let index = 0; index < files.length; index += 20) {
    Object.assign(
      reports,
      JSON.parse(run(binary, [...flags, ...files.slice(index, index + 20)], true)),
    );
  }
  if (json) console.log(JSON.stringify(reports, null, 2));
  else {
    let count = 0;
    for (const [path, alerts] of Object.entries(reports)) {
      for (const alert of alerts) {
        console.log(
          `${path}:${alert.Line}:${alert.Span[0]}: ${alert.Severity} ${alert.Check}: ${alert.Message}`,
        );
        count++;
      }
    }
    console.log(`Vale: ${files.length} files, ${count} advisory findings.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}

// Downloads the Pi release binary (Bun) for this OS and architecture, verifies it against the
// release's SHA256SUMS, extracts it and prints the binary's path. CI runs the engine inside it.
//   node scripts/pi-binary.mjs <version> <directory>
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [version = "1.1.0", dir = "pi-binary"] = process.argv.slice(2);
const os = { linux: "linux", darwin: "darwin", win32: "windows" }[process.platform];
const arch = { x64: "x64", arm64: "arm64" }[process.arch];
if (!os || !arch) throw new Error(`No Pi binary for ${process.platform}-${process.arch}`);
const asset = `pi-${os}-${arch}.${os === "windows" ? "zip" : "tar.gz"}`;
const base = `https://github.com/earendil-works/pi/releases/download/v${version}`;

async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const sums = (await download(`${base}/SHA256SUMS`)).toString("utf8");
const expected = sums
  .split("\n")
  .map((l) => l.trim().split(/\s+/))
  .find(([, name]) => name?.replace(/^\*/, "") === asset)?.[0];
if (!expected) throw new Error(`SHA256SUMS lists no ${asset}`);
const archive = await download(`${base}/${asset}`);
const actual = createHash("sha256").update(archive).digest("hex");
if (actual !== expected) throw new Error(`${asset}: sha256 ${actual} does not match ${expected}`);
await mkdir(dir, { recursive: true });
const file = join(dir, asset);
await writeFile(file, archive);
const r = spawnSync("tar", ["-xf", asset], { cwd: dir, stdio: "inherit" });
if (r.status !== 0) throw new Error(`tar could not extract ${asset}`);

async function find(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await find(path);
      if (found) return found;
    } else if (
      entry.name === (os === "windows" ? "pi.exe" : "pi") &&
      (await stat(path)).size > 1_000_000
    )
      return path;
  }
  return null;
}
const binary = await find(dir);
if (!binary) throw new Error("The archive has no pi binary");
console.log(binary);

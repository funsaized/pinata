import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { replaceProjection } from "../../../engine/storage/io.ts";

const directory = process.argv[2];
if (!directory) throw new Error("Expected a projection directory");
const path = join(directory, "projection.json");
const originalRename = fs.promises.rename;
const platform = Object.getOwnPropertyDescriptor(process, "platform");
if (!platform) throw new Error("Missing platform descriptor");
try {
  for (const scenario of [
    { platform: "win32", code: "EPERM", failures: 2, attempts: 3, succeeds: true },
    { platform: "win32", code: "EBUSY", failures: 1, attempts: 2, succeeds: true },
    { platform: "win32", code: "EACCES", failures: Infinity, attempts: 6, succeeds: false },
    { platform: "win32", code: "EIO", failures: 1, attempts: 1, succeeds: false },
    { platform: "linux", code: "EPERM", failures: 1, attempts: 1, succeeds: false },
  ]) {
    await fs.promises.writeFile(path, "original");
    const retained = new Set(await fs.promises.readdir(directory));
    const failure = Object.assign(new Error("Injected replacement error"), { code: scenario.code });
    let attempts = 0;
    fs.promises.rename = async (source, destination) => {
      attempts++;
      assert.equal(await fs.promises.readFile(path, "utf8"), "original");
      if (attempts <= scenario.failures) throw failure;
      await originalRename(source, destination);
    };
    Object.defineProperty(process, "platform", { ...platform, value: scenario.platform });
    syncBuiltinESMExports();
    const boundaries: string[] = [];
    const replacement = replaceProjection(
      path,
      Buffer.from("replacement"),
      "projection",
      (point) => {
        boundaries.push(point);
      },
    );
    if (scenario.succeeds) await replacement;
    else await assert.rejects(replacement, (error) => error === failure);
    assert.equal(attempts, scenario.attempts);
    assert.equal(boundaries.filter((point) => point === "projection.publish.before").length, 1);
    assert.equal(
      await fs.promises.readFile(path, "utf8"),
      scenario.succeeds ? "replacement" : "original",
    );
    const staged = (await fs.promises.readdir(directory)).filter((name) => !retained.has(name));
    assert.equal(staged.length, scenario.succeeds ? 0 : 1);
    for (const name of staged)
      assert.equal(await fs.promises.readFile(join(directory, name), "utf8"), "replacement");
  }
} finally {
  fs.promises.rename = originalRename;
  Object.defineProperty(process, "platform", platform);
  syncBuiltinESMExports();
}

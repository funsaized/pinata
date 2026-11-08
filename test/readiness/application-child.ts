// Test-only loader hook: terminate inside the real atomic writer without editing it.
import { registerHooks } from "node:module";
import { readFile } from "node:fs/promises";

const [operation, directory, fault = "", failure = "kill"] = process.argv.slice(2);
if (!directory) throw new Error("Application probe needs its disposable run directory");
if (fault) {
  const [record, status, boundary] = fault.split(":");
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (!url.endsWith("/engine/core/store.ts")) return loaded;
      let source = String(loaded.source);
      const needles: Record<string, string> = {
        written: "await handle.writeFile(encoded);",
        synced: "await handle.sync();",
        renamed: "await rename(tmp, file);",
        directory_synced: "await directory.sync();",
      };
      const needle = needles[boundary];
      if (!needle || source.split(needle).length < 2) throw new Error("Fault hook drifted");
      const condition = `file.replaceAll("\\\\", "/").endsWith(${JSON.stringify(`/integration/${record}.json`)}) && (${JSON.stringify(status)} === "any" || value?.status === ${JSON.stringify(status)})`;
      const interrupt =
        failure === "throw"
          ? 'throw new Error("READINESS_INJECTED_IO_FAILURE")'
          : 'process.kill(process.pid, "SIGKILL")';
      source = source.replace(needle, `${needle}\nif (${condition}) { ${interrupt}; }`);
      return { ...loaded, source };
    },
  });
}
const { integrate, rollback } = await import("../../engine/verify/integrate.ts");
try {
  const result =
    operation === "rollback"
      ? await rollback(directory, { recover: true })
      : await integrate(directory, undefined, undefined, { recover: true });
  console.log(
    JSON.stringify({
      result,
      journal: JSON.parse(await readFile(`${directory}/integration/journal.json`, "utf8")),
    }),
  );
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 2;
}

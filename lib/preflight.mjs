import * as fs from "node:fs/promises";
import path from "node:path";
import { ROOT, ROLES, need, command, environment, line, rpcProbe } from "./core.mjs";
import { config, executable } from "./config.mjs";
import { herdrEnv } from "./herdr.mjs";

export async function doctor(input = {}) {
  const cfg = config(input);
  cfg.pi = await executable(cfg.pi ?? "pi");
  cfg.herdr = await executable(cfg.herdr ?? "herdr");
  const versions = {};
  for (const [name, argv] of Object.entries({
    pi: [cfg.pi, "--version"],
    herdr: [cfg.herdr, "--version"],
    git: ["git", "--version"],
    node: [process.execPath, "--version"],
    npm: ["npm", "--version"],
    gh: ["gh", "--version"],
  })) {
    try {
      const r = await command(argv);
      versions[name] = r.code === 0 ? line(r.stdout).split("\n")[0] : "unavailable";
    } catch {
      versions[name] = "unavailable";
    }
  }
  need(versions.git !== "unavailable", "git is required");
  const minimum = (s, wanted) => {
    const m = s.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!m) return false;
    for (let i = 0; i < 3; i++) {
      if (+m[i + 1] > wanted[i]) return true;
      if (+m[i + 1] < wanted[i]) return false;
    }
    return true;
  };
  need(
    minimum(versions.pi, [1, 0, 2]) && minimum(versions.herdr, [0, 9, 1]),
    "pinata requires Pi >=1.0.2 and Herdr >=0.9.1; propose upgrades explicitly",
  );
  const target = cfg.session
    ? {}
    : Object.fromEntries(
        ["HERDR_SOCKET_PATH", "HERDR_SESSION"]
          .filter((k) => process.env[k])
          .map((k) => [k, process.env[k]]),
      );
  need(
    cfg.session || target.HERDR_SOCKET_PATH || target.HERDR_SESSION,
    "Choose config.session outside a Herdr pane; never implicitly use the focused server",
  );
  const run = { config: cfg, target };
  const status = await command(
    [cfg.herdr, ...(cfg.session ? ["--session", cfg.session] : []), "status"],
    { env: herdrEnv(run) },
  );
  need(
    status.code === 0 &&
      /status:\s+running/.test(status.stdout) &&
      /endpoint_compatible:\s+yes/.test(status.stdout),
    "Herdr server unavailable/incompatible; do not start, stop, or upgrade a shared server automatically",
  );
  const schema = await command([cfg.herdr, "api", "schema", "--json"]);
  need(
    schema.code === 0 && JSON.parse(schema.stdout).schemas?.success_response,
    "Unsupported Herdr schema",
  );
  await executable("ps");
  if (cfg.webExtension) {
    cfg.webExtension = await fs.realpath(cfg.webExtension);
    need(
      (await fs.stat(cfg.webExtension)).isFile(),
      "webExtension must be the installed pi-web-access entry file",
    );
  }
  return {
    config: cfg,
    target,
    versions,
    platform: process.platform,
    arch: process.arch,
    research: cfg.webExtension
      ? "entry configured; provider readiness is checked when used"
      : "requires an explicitly configured pi-web-access entry",
    optional: { vercel: "only needed for authorized Vercel deployments" },
  };
}
export async function resources(cwd = process.cwd(), input = {}) {
  const cfg = config(input),
    pi = await executable(cfg.pi ?? "pi");
  const data = await rpcProbe(
    pi,
    cwd,
    environment(cfg),
    [{ id: "commands", type: "get_commands" }],
    [],
    true,
  );
  const commands = data.get("commands")?.commands;
  need(Array.isArray(commands), "Invalid Pi resource metadata");
  const expected = Object.fromEntries([
    ...ROLES.map((role) => [role, path.join(ROOT, "prompts", `${role}.md`)]),
    ...["subagents", "engmgmt"].map((skill) => [
      `skill:${skill}`,
      path.join(ROOT, "skills", skill, "SKILL.md"),
    ]),
  ]);
  const mappings = Object.entries(expected).map(([name, file]) => ({
    name,
    expected: file,
    resolved: commands.filter((c) => c.name === name).map((c) => c.sourceInfo?.path),
  }));
  return {
    ok:
      !data.get("resourceWarnings") &&
      mappings.every((m) => m.resolved.length === 1 && m.resolved[0] === m.expected),
    mappings,
    resourceWarnings: data.get("resourceWarnings"),
    scope: "user resources; project resources are intentionally not trusted by this probe",
  };
}

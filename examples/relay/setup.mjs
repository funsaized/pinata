// Create the starter repository for a real-model Relay run.
import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const HERE = import.meta.dirname;

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message ?? result.stderr ?? "Git failed");
}

export async function setup(destination) {
  const cwd = resolve(destination);
  // mkdir without recursive/force refuses existing directories, files and symlinks.
  // Never reuse or reset a user's checkout.
  await mkdir(cwd);
  const source = join(HERE, "starter");
  for (const entry of await readdir(source))
    await cp(join(source, entry), join(cwd, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  for (const file of ["job.json", "expected-report.md", "verify.mjs"])
    await cp(join(HERE, file), join(cwd, file), { force: false, errorOnExist: true });
  // Keep exact-output checks stable in worktrees on Windows too.
  await writeFile(join(cwd, ".gitattributes"), "* text=auto eol=lf\n");
  const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
  manifest.scripts.verify = "node verify.mjs";
  await writeFile(join(cwd, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(
    join(cwd, "REQUIREMENTS.md"),
    (await readFile(join(cwd, "REQUIREMENTS.md"), "utf8")) +
      "\n## Portable exercise acceptance\n\nFor data/events.jsonl, CLI stdout must exactly match expected-report.md. Run node verify.mjs to check it. Preserve verify.mjs and expected-report.md.\n",
  );
  git(cwd, ["init", "--quiet"]);
  git(cwd, ["add", "--all"]);
  git(cwd, [
    "-c",
    "user.name=Pinata Relay",
    "-c",
    "user.email=relay@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "Relay exercise starting point",
  ]);
  return cwd;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || args[0].startsWith("--"))
      throw new Error("Usage: node setup.mjs <new-directory>");
    const cwd = await setup(args[0]);
    console.log(`Created Relay starter: ${cwd}`);
    console.log(
      "Open that directory, choose your models and limits in job.json, then run pinata run job.json --watch. The job uses your configured model credentials and spends tokens.",
    );
  } catch (error) {
    console.error(`Relay setup: ${error.message}`);
    process.exitCode = 1;
  }
}

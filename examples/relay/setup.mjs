// Create a disposable exercise without installing packages or calling a model.
import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message ?? result.stderr ?? "Git failed");
}

export async function setup(destination, { finished = false } = {}) {
  const cwd = resolve(destination);
  // mkdir without recursive/force refuses existing directories, files and symlinks.
  // Never reuse or reset a user's checkout.
  await mkdir(cwd);
  const source = join(HERE, finished ? "finished" : "starter");
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const destinations = args.filter((arg) => !arg.startsWith("--"));
    if (
      destinations.length !== 1 ||
      args.some((arg) => arg.startsWith("--") && arg !== "--finished")
    )
      throw new Error("Usage: node setup.mjs <new-directory> [--finished]");
    const finished = args.includes("--finished");
    const cwd = await setup(destinations[0], { finished });
    console.log(`Created ${finished ? "finished" : "starter"} Relay exercise: ${cwd}`);
    console.log(
      finished
        ? "Open that directory, then run npm test and npm run verify. No model access is needed."
        : "Open that directory and edit job.json to choose your model and spending limit. Running pinata run job.json --watch spends model tokens; setup has made no model calls.",
    );
  } catch (error) {
    console.error(`Relay setup: ${error.message}`);
    process.exitCode = 1;
  }
}

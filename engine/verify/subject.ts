// Subjects for reviews of existing changes (port of 0.7.0's subject.mjs). A review compares
// two commits: the head is the checkout as the run started (uncommitted changes included) or a
// fetched pull request; the base is where those changes began. The verdict binds to both.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { git, line, zsplit } from "../workspace/git.ts";
import { environment, killTree, launch } from "./checks.ts";

export interface Subject {
  kind: "uncommitted" | "branch" | "pull-request";
  ref: string;
  base: string;
  head: string;
  pr?: { number: number; title: string; url: string };
}

export class SubjectError extends Error {
  override name = "SubjectError";
}

export function subjectFingerprint(subject: Subject): string {
  return createHash("sha256").update(JSON.stringify(subject)).digest("hex");
}

async function nonEmpty(root: string, subject: Subject): Promise<Subject> {
  const diff = await git(root, ["diff", "--name-only", "--no-renames", subject.base, subject.head]);
  if (!diff.trim())
    throw new SubjectError(
      `Nothing to review: ${subject.head.slice(0, 12)} has no changes from its base`,
    );
  return subject;
}

// A local revision: the review covers everything from the merge base to the run's snapshot.
export async function localSubject(
  root: string,
  ref: string,
  snapshot: { head: string; commit: string },
): Promise<Subject> {
  let target: string;
  try {
    target = line(await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]));
  } catch {
    throw new SubjectError(`reviewBase ${JSON.stringify(ref)} is not a commit in this repository`);
  }
  const base = line(await git(root, ["merge-base", target, snapshot.head]));
  return nonEmpty(root, {
    kind: base === snapshot.head ? "uncommitted" : "branch",
    ref,
    base,
    head: snapshot.commit,
  });
}

function run(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 120_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // gh may be a .cmd launcher on Windows.
    const { file, args, verbatim } = launch(argv, env);
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a timeout also stops helpers (credential managers) that
      // would otherwise hold the pipes open.
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.pid !== undefined && killTree(child.pid), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (e) => (clearTimeout(timer), reject(e)));
    child.on("close", (code) => (clearTimeout(timer), resolve({ code, stdout, stderr })));
  });
}

// gh and git fetch get the allowlist plus the variables that carry GitHub and SSH credentials,
// which agents and checks never receive.
function networkEnv(passEnv: readonly string[]): NodeJS.ProcessEnv {
  // Never prompt: not in the terminal, and not through Git Credential Manager's windows.
  const env = environment(passEnv, { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" });
  delete env.PINATA_AGENT;
  for (const name of [
    "SSH_AUTH_SOCK",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_HOST",
    "GH_ENTERPRISE_TOKEN",
    "GH_CONFIG_DIR",
  ])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

async function remotesFor(
  root: string,
  host: string,
  owner: string,
  repo: string,
): Promise<string[]> {
  const want = `${owner}/${repo}`.toLowerCase();
  const names: string[] = [];
  for (const row of (await git(root, ["remote", "-v"])).split("\n")) {
    const [name, url = ""] = row.split(/\s+/);
    const clean = url
      .toLowerCase()
      .replaceAll("\\", "/")
      .replace(/\.git$/, "")
      .replace(/\/$/, "");
    if (
      name &&
      clean.includes(host.toLowerCase()) &&
      (clean.endsWith(`/${want}`) || clean.endsWith(`:${want}`)) &&
      !names.includes(name)
    )
      names.push(name);
  }
  return names;
}

// A GitHub pull request, fetched into private refs. A head that moves while it is fetched is
// refused.
export async function pullRequestSubject(
  root: string,
  runId: string,
  number: number,
  passEnv: readonly string[] = [],
): Promise<Subject> {
  const env = networkEnv(passEnv);
  let view;
  try {
    view = await run(
      ["gh", "pr", "view", String(number), "--json", "number,title,url,headRefOid,baseRefName"],
      root,
      env,
      60_000,
    );
  } catch {
    throw new SubjectError("Reviewing a pull request needs the GitHub CLI (gh) on PATH, signed in");
  }
  if (view.code !== 0)
    throw new SubjectError(`gh pr view ${number} failed: ${view.stderr.trim().slice(0, 500)}`);
  const pr = JSON.parse(view.stdout);
  const url = new URL(pr.url);
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  if (pr.number !== number || !owner || !repo || !/^[0-9a-f]{40,64}$/.test(pr.headRefOid))
    throw new SubjectError("Unexpected gh pull request metadata");
  if (typeof pr.baseRefName !== "string" || !/^[^\s-][^\s:]*$/.test(pr.baseRefName))
    throw new SubjectError("Unexpected pull request base branch");
  const headRef = `refs/pinata/${runId}/pr-${number}`;
  const baseRef = `${headRef}-base`;
  const sources = [
    ...(await remotesFor(root, url.host, owner, repo)),
    `${url.origin}/${owner}/${repo}.git`,
  ];
  let lastError = "";
  let fetched = false;
  for (const source of sources) {
    const r = await run(
      [
        "git",
        "-C",
        root,
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        source,
        `+refs/pull/${number}/head:${headRef}`,
        `+refs/heads/${pr.baseRefName}:${baseRef}`,
      ],
      root,
      env,
    );
    if (r.code === 0) {
      fetched = true;
      break;
    }
    lastError = r.stderr.trim().slice(0, 500);
  }
  if (!fetched) throw new SubjectError(`Could not fetch pull request ${number}: ${lastError}`);
  const head = line(await git(root, ["rev-parse", "--verify", headRef]));
  if (head !== pr.headRefOid)
    throw new SubjectError(
      `Pull request ${number} changed while it was fetched; ask again to review the new head`,
    );
  const base = line(
    await git(root, ["merge-base", line(await git(root, ["rev-parse", baseRef])), head]),
  );
  return nonEmpty(root, {
    kind: "pull-request",
    ref: pr.baseRefName,
    base,
    head,
    pr: { number, title: String(pr.title ?? "").slice(0, 300), url: pr.url },
  });
}

// The diff and changed files a reviewer of a subject reads.
export async function subjectDiff(
  root: string,
  subject: Subject,
): Promise<{ diff: string; changedFiles: Array<{ status: string; path: string }> }> {
  const diff = await git(root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--binary",
    subject.base,
    subject.head,
    "--",
  ]);
  const fields = zsplit(
    await git(root, [
      "diff",
      "--name-status",
      "--no-renames",
      "-z",
      subject.base,
      subject.head,
      "--",
    ]),
  );
  const changedFiles: Array<{ status: string; path: string }> = [];
  for (let i = 0; i + 1 < fields.length; i += 2)
    changedFiles.push({ status: fields[i], path: fields[i + 1] });
  return { diff, changedFiles };
}

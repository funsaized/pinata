import { need, git, line, command, environment } from "./core.mjs";
import { executable } from "./config.mjs";

// A review of existing changes compares two commits. The head is the checkout the
// job started from (uncommitted changes included) or a fetched pull request; the
// base is where those changes began. The verdict is bound to both commits.
export async function resolveSubject(run, spec) {
  if (spec.reviewBase !== undefined) return localSubject(run, spec.reviewBase);
  if (spec.reviewPr !== undefined) return pullRequestSubject(run, spec.reviewPr);
  return null;
}

export function validSubject(subject) {
  const sha = (value) => typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value);
  return (
    subject &&
    ["uncommitted", "branch", "pull-request"].includes(subject.kind) &&
    sha(subject.base) &&
    sha(subject.head)
  );
}

async function nonEmpty(run, subject) {
  const diff = await git(run.cwd, [
    "diff",
    "--name-only",
    "--no-renames",
    subject.base,
    subject.head,
  ]);
  need(diff.trim(), `Nothing to review: ${subject.head.slice(0, 12)} has no changes from its base`);
  return subject;
}

async function localSubject(run, ref) {
  const head = run.headCommit ?? run.baseCommit;
  let target;
  try {
    target = line(await git(run.cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]));
  } catch {
    throw new Error(`reviewBase ${JSON.stringify(ref)} is not a commit in this repository`);
  }
  const base = line(await git(run.cwd, ["merge-base", target, head]));
  return nonEmpty(run, {
    kind: base === head ? "uncommitted" : "branch",
    ref,
    base,
    head: run.baseCommit,
  });
}

// Environment for gh and git fetch: the worker allowlist plus the variables that
// carry GitHub and SSH credentials, which workers never receive.
function networkEnv(run) {
  const env = environment(run.config, { GIT_TERMINAL_PROMPT: "0" });
  for (const name of [
    "SSH_AUTH_SOCK",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_HOST",
    "GH_ENTERPRISE_TOKEN",
  ])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

// Remotes whose URL names the pull request's repository, best match first.
async function remotesFor(run, host, owner, repo) {
  const want = `${owner}/${repo}`.toLowerCase();
  const names = [];
  for (const row of (await git(run.cwd, ["remote", "-v"])).split("\n")) {
    const [name, url = ""] = row.split(/\s+/);
    const clean = url
      .toLowerCase()
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

async function pullRequestSubject(run, number) {
  let gh;
  try {
    gh = await executable("gh");
  } catch {
    throw new Error("Reviewing a pull request needs the GitHub CLI (gh) on PATH, signed in");
  }
  const env = networkEnv(run);
  const view = await command(
    [gh, "pr", "view", String(number), "--json", "number,title,url,headRefOid,baseRefName"],
    { cwd: run.cwd, env, timeoutMs: 60_000 },
  );
  need(view.code === 0, `gh pr view ${number} failed: ${view.stderr.trim().slice(0, 500)}`);
  const pr = JSON.parse(view.stdout);
  const url = new URL(pr.url);
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  need(
    pr.number === number && owner && repo && /^[0-9a-f]{40,64}$/.test(pr.headRefOid),
    "Unexpected gh pull request metadata",
  );
  need(
    typeof pr.baseRefName === "string" && /^[^\s-][^\s:]*$/.test(pr.baseRefName),
    "Unexpected pull request base branch",
  );
  const headRef = `refs/pinata/${run.id}/pr-${number}`;
  const baseRef = `${headRef}-base`;
  const sources = [
    ...(await remotesFor(run, url.host, owner, repo)),
    `${url.origin}/${owner}/${repo}.git`,
  ];
  let fetched = false,
    lastError = "";
  for (const source of sources) {
    const r = await command(
      [
        "git",
        "-C",
        run.cwd,
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        source,
        `+refs/pull/${number}/head:${headRef}`,
        `+refs/heads/${pr.baseRefName}:${baseRef}`,
      ],
      { env, timeoutMs: 120_000 },
    );
    if (r.code === 0) {
      fetched = true;
      break;
    }
    lastError = r.stderr.trim().slice(0, 500);
  }
  need(fetched, `Could not fetch pull request ${number}: ${lastError}`);
  const head = line(await git(run.cwd, ["rev-parse", "--verify", headRef]));
  need(
    head === pr.headRefOid,
    `Pull request ${number} changed while it was fetched; ask again to review the new head`,
  );
  const base = line(
    await git(run.cwd, ["merge-base", line(await git(run.cwd, ["rev-parse", baseRef])), head]),
  );
  return nonEmpty(run, {
    kind: "pull-request",
    ref: pr.baseRefName,
    base,
    head,
    pr: { number, title: String(pr.title ?? "").slice(0, 300), url: pr.url },
  });
}

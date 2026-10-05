import * as fs from "node:fs/promises";
import { need, readJson } from "./core.mjs";
import { doctor, resources } from "./preflight.mjs";
import { init, loadRun, summary, mutate } from "./run.mjs";
import { tick, wait, add, barrier, repair, retryLaunch, cancel } from "./schedule.mjs";
import { integrate, rollback } from "./integrate.mjs";
import { cleanup, unlock } from "./cleanup.mjs";

export const HELP = `pinata — Pi subagents through bash and Herdr (package: pi-pinata)\n\nnode <package>/lib/pinata.mjs <command> [arguments]\n  doctor [config.json]              Check local prerequisites; no installations\n  resources [cwd]                   Verify this installed package's exact global resources\n  init <job.json>                    Record approved scope; print private run path\n  add <run> <task.json>              Append a scoped task and dependencies\n  tick <run>                        Collect results and fill up to 3 worker slots\n  wait <run> [milliseconds]          Tick until settled or observation deadline\n  status <run>                      Inspect saved state (use resume to reconcile)\n  resume <run>                      Reconcile actual state, then schedule ready work\n  barrier <run> <task-id>...         Validate EVERY required predecessor\n  repair <run> <task-id> <text-file> Reuse work, invalidate reviews; bounded budget\n  retry-launch <run> <task-id>       Reconcile ambiguous submission; one same-attempt retry\n  cancel <run>                      Stop only owned work; verify termination\n  integrate <run>                   Require all results/reviews; apply and verify\n  rollback <run> --confirm          Restore latest integration only if unchanged\n  cleanup <run> [--confirm]          Preview/close owned idle panes; keep dirty worktrees\n  note <run> <note.json>            Record progress/authorization/release evidence\n  unlock <run>                      Recover a dead coordinator's lock; never steal\n\nNo global config changes, commits, pushes, publication, or deployment are performed\nby this helper. Scope/approval records are not an OS security boundary.\n`;
export async function main(args) {
  const [cmd, first, ...rest] = args;
  if (!cmd || ["help", "--help", "-h"].includes(cmd)) {
    console.log(HELP);
    return;
  }
  need(!process.env.PINATA_WORKER, "Recursive delegation is disabled in pinata workers");
  let result;
  switch (cmd) {
    case "doctor":
      result = await doctor(first ? await readJson(first) : {});
      break;
    case "resources":
      result = await resources(first);
      if (!result.ok) process.exitCode = 1;
      break;
    case "init":
      result = await init(await readJson(first));
      break;
    case "add":
      result = await add(first, await readJson(rest[0]));
      break;
    case "tick":
    case "resume":
      result = await tick(first);
      break;
    case "wait":
      result = await wait(first, rest[0] ? Number(rest[0]) : 30_000);
      break;
    case "status":
      result = summary(await loadRun(first));
      break;
    case "barrier":
      result = await barrier(first, rest);
      break;
    case "repair":
      result = await repair(first, rest[0], await fs.readFile(rest[1], "utf8"));
      break;
    case "retry-launch":
      result = await retryLaunch(first, rest[0]);
      break;
    case "cancel":
      result = await cancel(first);
      break;
    case "integrate":
      result = await integrate(first);
      break;
    case "rollback":
      need(rest[0] === "--confirm", "Rollback requires explicit --confirm and user authorization");
      result = await rollback(first);
      break;
    case "cleanup":
      need(
        rest.length === 0 || (rest.length === 1 && rest[0] === "--confirm"),
        "Unknown cleanup flag",
      );
      result = await cleanup(first, rest[0] === "--confirm");
      break;
    case "unlock":
      result = await unlock(first);
      break;
    case "note":
      result = await mutate(first, async (run) => {
        const note = await readJson(rest[0]);
        run.notes.push({ at: Date.now(), note });
      });
      break;
    default:
      throw new Error(`Unknown pinata command: ${cmd}`);
  }
  console.log(JSON.stringify(result, null, 2));
  if (cmd === "integrate" && result.integration?.status !== "verified") process.exitCode = 1;
  if (cmd === "wait" && !result.waiting && result.tasks.some((t) => t.status !== "succeeded"))
    process.exitCode = 1;
}

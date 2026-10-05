import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ROOT,
  TERMINAL,
  environment,
  living,
  processTable,
  equal,
  sleep,
  need,
  shellQuote,
} from "./core.mjs";
import { loadRun, mutate, save, summary } from "./run.mjs";
import { tick } from "./schedule.mjs";
import { herdr } from "./herdr.mjs";
import { observe, signalRun } from "./observe.mjs";

async function coordinator(run) {
  if (!process.env.HERDR_PANE_ID) return null;
  if (run.config.session && run.config.session !== process.env.HERDR_SESSION) return null;
  try {
    const { agent } = await herdr(run, ["agent", "get", process.env.HERDR_PANE_ID]);
    if (agent?.agent_session)
      return {
        pane: agent.pane_id,
        terminal: agent.terminal_id,
        session: agent.agent_session,
      };
  } catch {
    /* Without a known agent session, use a Herdr notification only. */
  }
  return null;
}

export async function start(dir) {
  return mutate(dir, async (run) => {
    need(!run.cancelled && Date.now() < run.deadline, "Run stopped");
    if (
      run.background?.status === "complete" &&
      run.tasks.every((t) => TERMINAL.includes(t.status))
    )
      return summary(run);
    if (
      ["starting", "running"].includes(run.background?.status) &&
      run.background?.runner &&
      (await living([run.background.runner])).length
    ) {
      await signalRun(run);
      return summary(run);
    }
    run.background = {
      token: randomUUID(),
      status: "starting",
      startedAt: Date.now(),
      coordinator: await coordinator(run),
    };
    await save(run);
    const log = await fs.open(
      path.join(run.dir, "background.log"),
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const child = spawn(
        process.execPath,
        [path.join(ROOT, "lib/background.mjs"), run.dir, run.background.token],
        {
          cwd: run.cwd,
          env: environment(run.config),
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
        },
      );
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      run.background.runner = (await processTable()).find((p) => p.pid === child.pid);
      need(
        run.background.runner,
        "Background coordinator exited during startup; inspect background.log",
      );
    } finally {
      await log.close();
    }
    return summary(run);
  });
}

async function announce(run) {
  const inspect = [process.execPath, path.join(ROOT, "lib/pinata.mjs"), "status", run.dir]
    .map(shellQuote)
    .join(" ");
  const text = `Pinata run ${run.id} finished: ${run.tasks.map((t) => `${t.spec.id}=${t.status}`).join(", ")}. Read the saved results with ${inspect}, then inspect every required outcome before continuing.`;
  const target = run.background.coordinator;
  if (target) {
    try {
      const { agent } = await herdr(run, ["agent", "get", target.pane]);
      need(
        agent?.terminal_id === target.terminal && equal(agent.agent_session, target.session),
        "Coordinator session changed",
      );
      await herdr(run, ["agent", "prompt", target.pane, text]);
      return "agent";
    } catch (e) {
      run.background.notificationError = e.message;
    }
  }
  await herdr(run, ["notification", "show", "Pinata finished", "--body", text, "--sound", "none"]);
  return "notification";
}

export async function background(dir, token) {
  const changes = await observe(dir);
  try {
    while (true) {
      const seen = changes.revision;
      const before = await loadRun(dir);
      if (before.background?.token !== token) return;
      try {
        await tick(dir);
        let done = false;
        await mutate(dir, async (run) => {
          if (run.background?.token !== token) {
            done = true;
            return;
          }
          done = run.tasks.every((t) => TERMINAL.includes(t.status));
          run.background.status = done ? "complete" : "running";
          if (done && !run.background.notifiedAt) {
            try {
              run.background.delivery = await announce(run);
            } catch (e) {
              run.background.notificationError = e.message;
            }
            run.background.notifiedAt = Date.now();
          }
        });
        if (done) return;
      } catch (e) {
        if (!e.message.startsWith("Run is locked")) throw e;
        await sleep(100);
        continue;
      }
      await changes.wait(seen, Math.min(5000, Math.max(1, before.deadline - Date.now())));
    }
  } finally {
    changes.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  background(process.argv[2], process.argv[3]).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });

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
  digest,
  sleep,
  need,
  shellQuote,
} from "./core.mjs";
import { loadRun, mutate, save, summary } from "./run.mjs";
import { tick } from "./schedule.mjs";
import { herdr } from "./herdr.mjs";
import { observe, signalRun } from "./observe.mjs";
import { ensureNode } from "./runtime.mjs";

async function coordinator(run, nativeSession) {
  if (!process.env.HERDR_PANE_ID) return null;
  if (run.config.session && run.config.session !== process.env.HERDR_SESSION) return null;
  try {
    const { agent } = await herdr(run, ["agent", "get", process.env.HERDR_PANE_ID]);
    if (agent?.agent_session)
      return {
        pane: agent.pane_id,
        terminal: agent.terminal_id,
        session: agent.agent_session,
        ...(agent.agent === "pi" && agent.agent_session.value === nativeSession
          ? { completion: "pi-extension" }
          : {}),
      };
  } catch {
    /* Without a known agent session, use a Herdr notification only. */
  }
  return null;
}

export async function start(dir, { nativeSession } = {}) {
  return mutate(dir, async (run) => {
    const terminal = run.tasks.every((t) => TERMINAL.includes(t.status));
    need(terminal || (!run.cancelled && Date.now() < run.deadline), "Run stopped");
    const key = completionKey(run);
    const previous = run.background;
    if (
      run.background?.status === "complete" &&
      terminal &&
      ((previous.notification?.status === "delivered" && previous.notification.key === key) ||
        (previous.notifiedAt &&
          previous.delivery &&
          !previous.notification &&
          run.tasks.every(
            (t) => !t.attempts.length || t.attempts.at(-1).startedAt <= previous.notifiedAt,
          )))
    )
      return summary(run);
    if (
      ["starting", "running", "complete"].includes(run.background?.status) &&
      run.background?.runner &&
      (await living([run.background.runner])).length
    ) {
      if (nativeSession) {
        const target = await coordinator(run, nativeSession);
        if (target?.completion === "pi-extension") run.background.coordinator = target;
      }
      await signalRun(run);
      return summary(run);
    }
    const node = await ensureNode(run);
    run.background = {
      token: randomUUID(),
      status: "starting",
      startedAt: Date.now(),
      coordinator: await coordinator(run, nativeSession),
      ...(terminal && previous?.notification?.key === key
        ? { coordinator: previous.coordinator, notification: previous.notification }
        : {}),
    };
    await save(run);
    const log = await fs.open(
      path.join(run.dir, "background.log"),
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const child = spawn(
        node,
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

function completionKey(run) {
  return digest(
    run.tasks.map((t) => [
      t.spec.id,
      t.status,
      t.attempts.at(-1)?.number,
      t.attempts.at(-1)?.fingerprint,
    ]),
  );
}

async function announce(run) {
  const inspect = [await ensureNode(run), path.join(ROOT, "lib/pinata.mjs"), "status", run.dir]
    .map(shellQuote)
    .join(" ");
  const text = `Pinata run ${run.id} finished [completion ${run.background.notification.id}]: ${run.tasks.map((t) => `${t.spec.id}=${t.status}`).join(", ")}. Read the saved results with ${inspect}, then inspect every required outcome before continuing. Repeated messages with this completion ID refer to the same results.`;
  const target = run.background.coordinator;
  if (target) {
    try {
      const { agent } = await herdr(run, ["agent", "get", target.pane]);
      need(
        agent?.terminal_id === target.terminal && equal(agent.agent_session, target.session),
        "Coordinator session changed",
      );
      const message =
        target.completion === "pi-extension"
          ? `/pinata-complete ${JSON.stringify({ run: run.dir, id: run.background.notification.id })}`
          : text;
      await herdr(run, ["agent", "prompt", target.pane, message]);
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
  let deliveryAttempts = 0;
  try {
    while (true) {
      const seen = changes.revision;
      const before = await loadRun(dir);
      if (before.background?.token !== token) return;
      try {
        await tick(dir);
        let done = false;
        let pending = false;
        let retryMs = 0;
        await mutate(dir, async (run) => {
          if (run.background?.token !== token) {
            done = true;
            return;
          }
          done = run.tasks.every((t) => TERMINAL.includes(t.status));
          run.background.status = done ? "complete" : "running";
          if (done) {
            const key = completionKey(run);
            if (run.background.notification?.key !== key)
              run.background.notification = {
                id: randomUUID(),
                key,
                status: "pending",
                attempts: 0,
              };
            const notice = run.background.notification;
            if (notice.status === "delivered") return;
            pending = true;
            if (deliveryAttempts >= 3) return;
            notice.status = "pending";
            notice.attempts++;
            deliveryAttempts++;
            // Persist the outbox before delivery. Herdr has no idempotency key:
            // an accepted request with a lost reply can be repeated, using the
            // stable completion ID so the coordinator can recognize duplicates.
            await save(run);
            try {
              run.background.delivery = await announce(run);
              notice.status = "delivered";
              notice.deliveredAt = Date.now();
              run.background.notifiedAt = notice.deliveredAt;
              delete notice.error;
              pending = false;
            } catch (e) {
              run.background.notificationError = e.message;
              notice.error = e.message;
              retryMs = 250 * 2 ** (deliveryAttempts - 1);
            }
          }
        });
        if (done) {
          if (!pending || deliveryAttempts >= 3) return;
          await sleep(retryMs);
          continue;
        }
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

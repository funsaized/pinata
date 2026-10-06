import { start } from "./background.mjs";
import { loadRun, summary } from "./run.mjs";
import { finishNote } from "./progress.mjs";
import { TERMINAL, checkedKeys, need, text } from "./core.mjs";

const MESSAGE = "pinata-completion";
const BINDING = "pinata-run";
const session = (ctx) => ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
const interactive = (ctx) => ["tui", "rpc"].includes(ctx.mode);
const pending = (run) =>
  run.tasks.some((task) => !TERMINAL.includes(task.status)) ||
  run.background?.notification?.status !== "delivered";

// Herdr carries a command to the pinned Pi session. Pi, rather than terminal
// input, owns the resulting follow-up message and whether it starts a new turn.
export function registerCompletion(pi) {
  if (process.env.PINATA_WORKER) return null;
  let queued = new Set();
  let receiving = Promise.resolve();

  function seen(ctx, id) {
    return ctx.sessionManager
      .getBranch()
      .some(
        (entry) =>
          entry.type === "custom_message" &&
          entry.customType === MESSAGE &&
          entry.details?.id === id,
      );
  }

  async function receive(payload, ctx) {
    checkedKeys(payload, ["run", "id"], "completion");
    text(payload.run, "run directory");
    need(
      typeof payload.id === "string" && /^[a-f0-9-]{36}$/.test(payload.id),
      "Invalid completion ID",
    );
    const run = await loadRun(payload.run);
    const target = run.background?.coordinator;
    need(
      target?.completion === "pi-extension" && target.session.value === session(ctx),
      "Completion belongs to another Pi session",
    );
    need(run.background.notification?.id === payload.id, "Stale completion ID");
    need(
      run.tasks.every((task) => TERMINAL.includes(task.status)),
      "Workers are still running",
    );
    if (queued.has(payload.id) || seen(ctx, payload.id)) return;
    queued.add(payload.id);
    try {
      pi.sendMessage(
        {
          customType: MESSAGE,
          content: `Pinata run ${run.id} finished: ${run.tasks.map((task) => `${task.spec.id}=${task.status}`).join(", ")}.${finishNote(run)} Read pinata_status with run=${JSON.stringify(run.dir)} and includeResults=true, then use pinata_barrier for every required successful task before continuing. Completion ID: ${payload.id}.`,
          display: true,
          details: payload,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch (error) {
      queued.delete(payload.id);
      throw error;
    }
  }

  function enqueue(payload, ctx) {
    const operation = receiving.then(() => receive(payload, ctx));
    receiving = operation.catch(() => {});
    return operation;
  }

  pi.registerCommand("pinata-complete", {
    description: "Receive a saved Pinata completion from Herdr (internal).",
    async handler(args, ctx) {
      try {
        await enqueue(JSON.parse(args), ctx);
      } catch (error) {
        ctx.ui.notify(`Pinata completion: ${error.message}`, "error");
      }
    },
  });

  async function recover(ctx) {
    if (!interactive(ctx) || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    // Recover an accepted notification whose queued message did not survive an
    // exit/reload. Completed custom messages are the durable deduplication record.
    const dirs = new Set(
      ctx.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === BINDING)
        .map((entry) => entry.data?.run)
        .filter((dir) => typeof dir === "string"),
    );
    for (const dir of dirs) {
      try {
        const run = await loadRun(dir);
        if (
          run.background?.notification &&
          run.tasks.every((task) => TERMINAL.includes(task.status))
        )
          await enqueue({ run: dir, id: run.background.notification.id }, ctx);
      } catch (error) {
        ctx.ui.notify(`Pinata recovery: ${error.message}`, "warning");
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    queued = new Set();
    await recover(ctx);
  });
  // A reload during active work must let already queued follow-ups settle first.
  // This also recovers completion when terminal submission was blocked by a UI.
  pi.on("agent_settled", async (_event, ctx) => {
    await recover(ctx);
  });

  return {
    async start(dir, ctx, shouldYield = true) {
      const result = await start(dir, {
        nativeSession: interactive(ctx) ? session(ctx) : undefined,
      });
      if (interactive(ctx) && result.background.completion === "pi-extension") {
        const run = await loadRun(result.run);
        if (run.background.coordinator.session.value !== session(ctx)) return result;
        if (
          !ctx.sessionManager
            .getBranch()
            .some(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === BINDING &&
                entry.data?.run === result.run,
            )
        )
          pi.appendEntry(BINDING, { run: result.run });
        if (shouldYield && pending(result)) return { ...result, waiting: true };
      }
      return result;
    },
    async yield(dir, ctx) {
      const run = await loadRun(dir);
      need(interactive(ctx), "Yield requires an interactive Pi or RPC session");
      need(
        run.background?.coordinator?.completion === "pi-extension" &&
          run.background.coordinator.session.value === session(ctx),
        "Start this run with pinata_control in this Pi session before yielding",
      );
      need(
        run.background.status !== "stopped",
        "Background coordinator stopped; start it before yielding",
      );
      return { ...summary(run), waiting: pending(run) };
    },
  };
}

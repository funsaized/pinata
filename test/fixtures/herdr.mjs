#!/usr/bin/env node
import fs from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
let args = process.argv.slice(2);
if (args[0] === "--session") args = args.slice(2);
const arg = (key) => args[args.indexOf(key) + 1];
const send = (result) => console.log(JSON.stringify({ id: "fixture", result }));
const error = (code) => {
  console.error(JSON.stringify({ id: "fixture", error: { code, message: "Fixture error" } }));
  process.exitCode = 1;
};
if (args[0] === "--version") console.log("herdr 0.9.1");
else if (args[0] === "status")
  console.log("server:\n  status: running\n  endpoint_compatible: yes");
else if (args[0] === "api") console.log(JSON.stringify({ schemas: { success_response: {} } }));
else {
  const file = process.env.TEST_HERDR_STATE;
  let state;
  try {
    state = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    state = { resources: [], submissions: 0 };
  }
  const save = () => fs.writeFile(file, JSON.stringify(state));
  const live = (pid) => {
    if (!pid) return false;
    try {
      return !execFileSync("ps", ["-p", String(pid), "-o", "stat="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .trim()
        .startsWith("Z");
    } catch {
      return false;
    }
  };
  if (args[0] === "agent" && args[1] === "get") {
    if (!process.env.TEST_COORDINATOR) error("agent_not_found");
    else
      send({
        agent: {
          pane_id: args[2],
          terminal_id: "coordinator-terminal",
          agent: "pi",
          agent_session: {
            agent: "pi",
            kind: "path",
            source: "fixture",
            value: state.coordinatorSession ?? process.env.TEST_COORDINATOR,
          },
        },
      });
  } else if (args[0] === "agent" && args[1] === "prompt") {
    (state.notifications ??= []).push({ kind: "agent", target: args[2], text: args[3] });
    await save();
    if (process.env.TEST_PARENT_SOCKET) {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection(process.env.TEST_PARENT_SOCKET);
        socket.on("error", reject);
        socket.on("connect", () => socket.end(JSON.stringify({ text: args[3] }) + "\n"));
        socket.on("close", resolve);
      });
    }
    send({ type: "agent_prompted" });
  } else if (args[0] === "notification" && args[1] === "show") {
    state.notificationAttempts = (state.notificationAttempts ?? 0) + 1;
    const failures = state.notificationFailures ?? Number(process.env.TEST_NOTIFY_FAILURES ?? 0);
    if (state.notificationAttempts <= failures) {
      await save();
      error("timeout");
    } else {
      (state.notifications ??= []).push({ kind: "notification", text: arg("--body") });
      await save();
      send({ type: "notification_shown" });
    }
  } else if (args[0] === "workspace" && args[1] === "create") {
    const n = state.resources.length + 1;
    const pane = {
      pane_id: "w" + n + ":p1",
      terminal_id: "terminal-" + n,
      workspace_id: "w" + n,
      tab_id: "w" + n + ":t1",
      cwd: arg("--cwd"),
      agent_status: "idle",
    };
    state.resources.push({ pane, label: arg("--label") });
    await save();
    if (process.env.TEST_AMBIGUOUS_CREATE && !state.createFailed) {
      state.createFailed = true;
      await save();
      error("timeout");
    } else
      send({
        type: "workspace_created",
        workspace: { workspace_id: pane.workspace_id },
        tab: { tab_id: pane.tab_id },
        root_pane: pane,
      });
  } else if (args[0] === "workspace" && args[1] === "list") {
    send({
      workspaces: state.resources.map((r) => ({
        workspace_id: r.pane.workspace_id,
        label: r.label,
      })),
    });
  } else if (args[0] === "pane" && args[1] === "list") {
    send({
      panes: state.resources
        .filter((r) => r.pane.workspace_id === arg("--workspace"))
        .map((r) => r.pane),
    });
  } else {
    const resource = state.resources.find(
      (r) => r.pane.pane_id === (args[2] === "--pane" ? args[3] : args[2]),
    );
    if (!resource || resource.closed) error("pane_not_found");
    else if (args[1] === "get") send({ pane: resource.pane });
    else if (args[1] === "process-info") {
      const busy = live(resource.pid) || process.env.TEST_BUSY;
      send({
        process_info: {
          shell_pid: 123,
          foreground_process_group_id: busy ? 456 : 123,
          foreground_processes: [{ pid: busy ? 456 : 123, name: busy ? "node" : "bash" }],
        },
      });
    } else if (args[1] === "run") {
      if (process.env.TEST_AMBIGUOUS_BEFORE && !state.beforeFailed) {
        state.beforeFailed = true;
        await save();
        error("timeout");
      } else {
        const child = spawn("/bin/sh", ["-c", args[3]], {
          cwd: resource.pane.cwd,
          env: process.env,
          detached: true,
          stdio: "ignore",
        });
        resource.pid = child.pid;
        state.submissions++;
        await save();
        child.unref();
        if (process.env.TEST_AMBIGUOUS_AFTER && !state.afterFailed) {
          state.afterFailed = true;
          await save();
          error("timeout");
        } else send({ type: "pane_input_sent" });
      }
    } else if (args[1] === "close") {
      resource.closed = true;
      const ambiguous = process.env.TEST_AMBIGUOUS_CLOSE && !state.closeFailed;
      if (ambiguous) state.closeFailed = true;
      await save();
      if (ambiguous) error("timeout");
      else send({ type: "pane_closed" });
    } else error("unexpected_fixture_command");
  }
}

#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const arg = (key) => args[args.indexOf(key) + 1];
const send = (value) => console.log(JSON.stringify(value));
if (args.includes("--version")) console.log("1.0.2");
else if (args[0] === "auth") {
  send({ status: process.env.TEST_AUTH_MISSING ? "not_ready" : "ready" });
  process.exitCode = process.env.TEST_AUTH_MISSING ? 1 : 0;
} else if (arg("--mode") === "rpc") {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let pos;
    while ((pos = buffer.indexOf("\n")) !== -1) {
      const req = JSON.parse(buffer.slice(0, pos));
      buffer = buffer.slice(pos + 1);
      const data =
        req.type === "get_available_models"
          ? { models: [{ provider: "fixture", id: "fixture-model" }] }
          : {
              model: { provider: arg("--provider"), id: arg("--model") },
              thinkingLevel: arg("--thinking"),
            };
      send({ type: "response", id: req.id, command: req.type, success: true, data });
    }
  });
} else {
  const dir = path.dirname(arg("--append-system-prompt"));
  const spec = JSON.parse(await fs.readFile(path.join(dir, "task.json"), "utf8"));
  const scenario = JSON.parse(spec.task.task);
  await fs.appendFile(path.join(dir, "calls.txt"), "call\n");
  await fs.writeFile(path.join(dir, "args.json"), JSON.stringify(args));
  if (scenario.delay) await new Promise((r) => setTimeout(r, scenario.delay));
  send({ type: "session", id: "fixture-session" });
  send({ type: "agent_start" });
  if (scenario.hang) {
    if (scenario.child) {
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        detached: true,
        stdio: "ignore",
      });
      await fs.writeFile(path.join(dir, "child-pid"), String(child.pid));
      child.unref();
    }
    await new Promise(() => {
      setInterval(() => {}, 1000);
    });
  }
  if (scenario.expect)
    for (const [file, value] of Object.entries(scenario.expect)) {
      if ((await fs.readFile(path.join(process.cwd(), file), "utf8")) !== value)
        throw new Error("Dependency barrier did not provide code");
    }
  const writes = scenario.write ?? {};
  for (const [file, original] of Object.entries(spec.resultRepair ? {} : writes)) {
    const data = spec.feedback && scenario.repair ? scenario.repair : original;
    if (data === null) await fs.unlink(path.join(process.cwd(), file));
    else {
      await fs.mkdir(path.dirname(path.join(process.cwd(), file)), { recursive: true });
      await fs.writeFile(path.join(process.cwd(), file), data);
    }
  }
  let rejected = Boolean(scenario.reject);
  if (scenario.rejectBad)
    rejected = (await fs.readFile(path.join(process.cwd(), "a.txt"), "utf8")) === "bad";
  const result = {
    schemaVersion: 1,
    runId: spec.runId,
    taskId: spec.task.id,
    attemptId: spec.attemptId,
    taskDigest: spec.taskDigest,
    status: scenario.blocked ? "blocked" : "succeeded",
    summary: 'Fixture outcome with quotes " and Unicode 雨\nnext line',
    changedFiles: Object.keys(writes).sort(),
    commit: null,
    checks: [],
    findings: rejected
      ? [
          {
            severity: "high",
            message: "Incorrect value",
            evidence: "a.txt:1 — bad is not the accepted value",
          },
        ]
      : [],
    blockers: scenario.blocked ? ["Fixture blocker"] : [],
  };
  if (["scout", "planner", "research"].includes(spec.task.role))
    result.brief = "Relevant files and evidence; not a live-model evaluation.";
  if (spec.task.role === "research" && !scenario.noSources)
    result.sources = [
      {
        url: "https://example.com/fixture",
        title: "Mock source",
        supports: "Fixture claim",
        applicability: "Test fixture only",
      },
    ];
  if (spec.task.role === "reviewer")
    result.review = {
      taskId: spec.reviewTarget.taskId,
      fingerprint: spec.reviewTarget.fingerprint,
      verdict: rejected ? "changes_requested" : "approve",
    };
  if (scenario.wrongId && !(scenario.formatRepair && spec.resultRepair))
    result.taskId = "other-task";
  if (scenario.noResult) {
    send({ type: "agent_settled" });
  } else if (scenario.malformed) console.log("not JSON");
  else {
    send({
      type: "message_end",
      message: {
        role: "assistant",
        provider: spec.model.provider,
        model: spec.model.id,
        stopReason: scenario.error ? "error" : "stop",
        content: [{ type: "text", text: JSON.stringify(result) }],
      },
    });
    send({ type: "turn_end" });
    send({ type: "agent_end", willRetry: false });
    send({ type: "agent_settled" });
  }
}

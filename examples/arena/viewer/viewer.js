const $ = (s) => document.querySelector(s);
const colors = ["#b096ff", "#bde49e", "#8fcafa", "#ffb983"];
const phases = ["planning", "scouting", "building", "checking", "reviewing", "integrating"];
let state;
let selected;
let cursor = Infinity;
let playing = false;
let lastFrame = 0;
let playTime = 0;
const money = (n) => (n === null || n === undefined ? "unknown" : `$${n.toFixed(3)}`);
const seconds = (n) => `${(n / 1000).toFixed(1)}s`;
function node(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
function replace(target, children) {
  target.replaceChildren(...children);
}
function shownEvents() {
  return (state?.events ?? []).filter((e) => e.seq <= cursor);
}
function trialResult(events, id) {
  return events.findLast((e) => e.trial === id && e.type === "trial-settled")?.data;
}
function modelName(model) {
  return `${model.provider}/${model.id}`;
}
function render() {
  if (!state) return;
  const events = shownEvents();
  const all = state.events;
  const manifest = state.manifest;
  const simulated = manifest.mode === "simulated";
  const contestants = manifest.contestants;
  selected ??= contestants[0]?.id;
  $("#mode").textContent = simulated ? "SIMULATED · FIXTURES" : "LIVE · SELF-REPORTED ADAPTERS";
  $("#disclosure").textContent = simulated
    ? manifest.simulatedNotice
    : "Real configured containers. Stack adapters remain unverified until independently audited. Missing billing data is unknown; observed limits are not hard billing caps.";
  $("#run-status").textContent =
    `${manifest.track.replaceAll("-", " ")} · ${manifest.task.id} · ${cursor === Infinity ? (state.complete ? "complete" : "recording") : "replay"}`;
  $("#event-count").textContent = `${events.length} / ${all.length} events`;
  $("#scrub").max = Math.max(0, all.length - 1);
  $("#scrub").value = Math.min(Number.isFinite(cursor) ? cursor : all.length - 1, all.length - 1);
  $("#play").disabled = cursor === Infinity;
  $("#play").textContent = playing ? "Pause" : "Play";
  const results = events.filter((e) => e.type === "trial-settled").map((e) => e.data);
  const latest = (id) =>
    [...events].reverse().find((e) => e.type === "trial-started" && e.data.contestant === id);
  const lanes = contestants.map((c, index) => {
    const start = latest(c.id);
    const id = start?.trial;
    const result = id && trialResult(events, id);
    const activity = events.filter((e) => e.trial === id && e.type === "protocol");
    const currentPhase = activity.findLast((e) => e.data.type === "phase")?.data;
    const rows = results.filter((r) => r.contestant === c.id);
    const button = node("button", `lane${selected === c.id ? " selected" : ""}`);
    button.style.setProperty("--lane-color", colors[index % colors.length]);
    button.setAttribute("aria-label", `Inspect ${c.name} evidence`);
    button.setAttribute("aria-pressed", String(selected === c.id));
    button.onclick = () => {
      selected = c.id;
      render();
    };
    const top = node("div", "lane-top");
    top.append(
      node("span", "lane-number", `LANE ${String(index + 1).padStart(2, "0")}`),
      node(
        "span",
        "badge",
        simulated ? `fixture · ${start?.data.fixture ?? "queued"}` : "live · contract",
      ),
    );
    const title = node("h2", "", c.name ?? c.id);
    const version = node(
      "p",
      "version",
      `v${c.version} configured · ${simulated ? "scripted FakeBackend" : "pinned container"}`,
    );
    const status = result
      ? result.quality?.success && result.status === "completed"
        ? "Private checks passed"
        : result.quality
          ? `Private checks: ${result.quality.passed}/${result.quality.total}`
          : `${result.status}: ${result.reason ?? "no candidate"}`
      : start
        ? `${currentPhase?.phase ?? "starting"} · repetition ${start.data.repetition}`
        : "Waiting for a fresh workspace";
    const statusEl = node("div", "lane-state");
    statusEl.append(node("i", "state-dot"), node("span", "", status));
    const rail = node("div", "rail");
    for (const phase of phases)
      rail.append(
        node(
          "span",
          result || phases.indexOf(phase) <= phases.indexOf(currentPhase?.phase) ? "done" : "",
        ),
      );
    const metrics = node("div", "metrics");
    const receipts = activity.filter((e) => e.data.type === "usage");
    const knownPartial = new Map();
    for (const e of receipts) knownPartial.set(e.data.id, e.data.meters.costUsd);
    const partial = [...knownPartial.values()].reduce((n, cost) => n + (cost ?? 0), 0);
    const cost = result ? money(result.ledger.totals.costUsd) : start ? `≥${money(partial)}` : "—";
    const ms = result?.elapsedMs ?? (start ? (events.at(-1)?.at ?? start.at) - start.at : 0);
    for (const [label, text] of [
      ["QUALITY", result?.quality ? `${result.quality.passed}/${result.quality.total}` : "pending"],
      [simulated ? "FAKE COST" : "TOTAL COST", cost],
      ["ELAPSED", start ? seconds(ms) : "—"],
    ]) {
      const m = node("div", "metric");
      m.append(node("label", "", label), node("strong", "", text));
      metrics.append(m);
    }
    const note = result
      ? `${result.comparable ? "Model ids match track." : "Model mismatch: not comparable."} ${rows.length} settled attempt${rows.length === 1 ? "" : "s"}. ${result.patch ? "Final patch frozen." : "No frozen candidate."}`
      : "Parent, child and repair receipts stay visible through the full attempt.";
    button.append(top, title, version, statusEl, rail, metrics, node("p", "lane-note", note));
    return button;
  });
  replace($("#lanes"), lanes);
  const aggregates = contestants.map((c) => {
    const rows = results.filter((r) => r.contestant === c.id);
    const successes = rows.filter((r) => r.status === "completed" && r.quality?.success).length;
    const total = rows.reduce((n, r) => n + r.ledger.partial.costUsd, 0);
    const known = rows.length > 0 && rows.every((r) => r.ledger.totals.costUsd !== null);
    return { c, rows, successes, total, known };
  });
  replace(
    $("#results"),
    aggregates.map(({ c, rows, successes, total, known }) => {
      const tr = node("tr");
      for (const text of [
        c.name ?? c.id,
        `${successes} / ${rows.length}`,
        known ? money(total) : rows.length ? `unknown (≥${money(total)})` : "—",
        known && successes ? money(total / successes) : "undefined",
      ])
        tr.append(node("td", "", text));
      return tr;
    }),
  );
  const ns = "http://www.w3.org/2000/svg";
  const bubbles = [];
  const maxCost = Math.max(0.01, ...results.map((r) => r.ledger.totals.costUsd ?? 0)) * 1.2;
  for (const [i, c] of contestants.entries()) {
    const rows = results.filter(
      (r) => r.contestant === c.id && r.quality && r.ledger.totals.costUsd !== null,
    );
    if (!rows.length) continue;
    const cost = rows.reduce((n, r) => n + r.ledger.totals.costUsd, 0) / rows.length;
    const quality = rows.reduce((n, r) => n + r.quality.passed / r.quality.total, 0) / rows.length;
    // Separate coincident marks by a few pixels so identical fixture outcomes remain visible.
    const x = 65 + (cost / maxCost) * 470 + (i - 1) * 7;
    const y = 235 - quality * 200 + (i - 1) * 6;
    const circle = document.createElementNS(ns, "circle");
    for (const [key, value] of Object.entries({
      cx: x,
      cy: y,
      r: Math.min(
        24,
        9 + Math.sqrt(rows.reduce((n, r) => n + r.elapsedMs, 0) / rows.length / 1000) * 3,
      ),
      fill: colors[i % colors.length],
      "fill-opacity": ".18",
      stroke: colors[i % colors.length],
      "stroke-width": "1.5",
    }))
      circle.setAttribute(key, String(value));
    const title = document.createElementNS(ns, "title");
    title.textContent = `${c.name ?? c.id}: ${(quality * 100).toFixed(0)}% checks, ${money(cost)}, ${simulated ? "synthetic fixture" : "recorded"}`;
    circle.append(title);
    bubbles.push(circle);
    const text = document.createElementNS(ns, "text");
    text.setAttribute("x", String(x + 25));
    text.setAttribute("y", String(y + i * 15));
    text.setAttribute("class", "bubble-label");
    text.textContent = c.id;
    bubbles.push(text);
  }
  replace($("#bubbles"), bubbles);
  $("#cost-note").textContent =
    `${simulated ? "Synthetic fixture cost; elapsed time measures this rehearsal only. " : "Recorded/estimated cost; see receipt pricing provenance. "}Unknown-cost attempts are omitted from the chart. Coincident marks are offset slightly for visibility.`;
  const contestant = contestants.find((c) => c.id === selected);
  $("#selected-name").textContent = contestant?.name ?? selected;
  $("#selected-badge").textContent = simulated ? "SCRIPTED DELEGATION" : "ADAPTER-REPORTED";
  const trial = latest(selected)?.trial;
  const result = trial && trialResult(events, trial);
  const activity = events.filter((e) => e.trial === trial && e.type === "protocol");
  const sessions = activity.filter((e) => e.data.type === "session-open");
  replace(
    $("#sessions"),
    sessions.length
      ? sessions.map(({ data: s }) => {
          const receipts = activity.filter(
            (e) => e.data.type === "usage" && e.data.session === s.id,
          );
          const unique = new Map(receipts.map((e) => [e.data.id, e.data]));
          const values = [...unique.values()];
          const closed = activity.find(
            (e) => e.data.type === "session-close" && e.data.id === s.id,
          )?.data;
          const complete =
            closed?.usageComplete &&
            values.length > 0 &&
            values.every((r) => r.meters.costUsd !== null);
          const cost = values.reduce((n, r) => n + (r.meters.costUsd ?? 0), 0);
          const row = node("div", `session${s.parent ? " child" : ""}`);
          const identity = node("div", "", `${s.parent ? "↳ " : "◈ "}${s.role} / ${s.id}`);
          identity.append(node("small", "", modelName(s.model)));
          const receipt = node(
            "div",
            "receipt",
            complete ? money(cost) : `unknown · ≥${money(cost)}`,
          );
          receipt.append(
            node(
              "small",
              "",
              `${values.length} receipt${values.length === 1 ? "" : "s"} · ${closed ? "closed" : "open"}`,
            ),
          );
          row.append(identity, receipt);
          return row;
        })
      : [node("p", "muted", "Sessions appear when the selected lane starts.")],
  );
  const patch = $("#patch");
  patch.replaceChildren();
  if (result?.patch) {
    patch.append(node("p", "", `SHA-256 ${result.patch.sha256}`));
    const link = node("a", "", "Inspect frozen final patch ↗");
    link.href = `/artifact/${result.id}/final.patch`;
    link.target = "_blank";
    link.rel = "noopener";
    patch.append(link);
    patch.append(
      node(
        "p",
        "",
        result.quality
          ? `${result.quality.rubric}: ${result.quality.passed}/${result.quality.total} · ${result.quality.reason ?? "passed"}`
          : "No completed external verification",
      ),
    );
  } else
    patch.append(
      node("p", "", "Final patch and independent check evidence appear after generation ends."),
    );
  const timeline = events
    .filter(
      (e) =>
        e.trial === trial &&
        (e.type !== "protocol" ||
          ["phase", "session-open", "session-close", "terminal"].includes(e.data.type)),
    )
    .slice(-50)
    .reverse();
  $("#timeline-count").textContent = `${timeline.length} EVENTS`;
  replace(
    $("#timeline"),
    timeline.map((e) => {
      const li = node("li");
      const start = events.find((e) => e.trial === trial && e.type === "trial-started")?.at ?? e.at;
      const time = node("time", "", `+${seconds(e.at - start)}`);
      const body = node("div");
      body.append(
        node(
          "strong",
          "",
          e.type === "protocol" ? (e.data.phase ?? e.data.type) : e.type.replaceAll("-", " "),
        ),
      );
      body.append(
        document.createElement("br"),
        node(
          "span",
          "",
          e.data.detail ??
            e.data.reason ??
            e.data.role ??
            (e.type === "verified"
              ? `${e.data.passed}/${e.data.total} private checks passed`
              : e.type === "patch-frozen"
                ? e.data.sha256.slice(0, 20) + "…"
                : (e.data.status ?? "")),
        ),
      );
      li.append(time, body);
      return li;
    }),
  );
  $("#provenance").textContent =
    `Source ${manifest.sourceCommit.slice(0, 12)} · task ${manifest.task.sha256.slice(0, 12)} · ${manifest.node} · no remote assets`;
}
$("#replay").onclick = () => {
  cursor = 0;
  playTime = state?.events[0]?.at ?? 0;
  playing = true;
  lastFrame = 0;
  render();
};
$("#play").onclick = () => {
  playing = !playing;
  lastFrame = 0;
  render();
};
$("#latest").onclick = () => {
  cursor = Infinity;
  playing = false;
  render();
};
$("#scrub").oninput = (e) => {
  cursor = Number(e.target.value);
  playing = false;
  playTime = state?.events[cursor]?.at ?? 0;
  render();
};
function animate(now) {
  if (playing && state) {
    if (lastFrame) playTime += Math.min(100, now - lastFrame) * Number($("#speed").value);
    const next = state.events.findLast((e) => e.at <= playTime)?.seq ?? 0;
    if (next !== cursor) {
      cursor = next;
      render();
    }
    if (cursor >= state.events.length - 1) {
      playing = false;
      render();
    }
  }
  lastFrame = now;
  requestAnimationFrame(animate);
}
async function refresh() {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) throw Error();
    state = await response.json();
    render();
  } catch {
    if (!state)
      $("#disclosure").textContent =
        "Waiting for a readable event log. Start the runner in another terminal.";
  }
}
await refresh();
setInterval(refresh, 1000);
requestAnimationFrame(animate);

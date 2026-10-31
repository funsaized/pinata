import { aggregate } from "/summary.mjs";
const $ = (s) => document.querySelector(s);
let state, selected, selectedTrial;
let cursor = Infinity,
  playing = false,
  lastFrame = 0,
  playTime = 0;
let detailKey;
const money = (n) => (n == null ? "unknown" : `$${n.toFixed(n > 0 && n < 0.01 ? 6 : 3)}`);
const seconds = (n) => `${(n / 1000).toFixed(1)}s`;
const count = (n) => (n == null ? "unknown" : n.toLocaleString("en-US"));
const modelName = (m) => `${m.provider}/${m.id}`;
function node(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
function cell(row, text, className) {
  const td = node("td", className, text);
  row.append(td);
  return td;
}
function metric(label, value) {
  const e = node("div", "metric");
  e.append(node("span", "", label), node("strong", "", value));
  return e;
}
function render() {
  if (!state) return;
  const { manifest, events: all } = state;
  const events = all.filter((e) => e.seq <= cursor);
  const results = events.filter((e) => e.type === "trial-settled").map((e) => e.data);
  const starts = events.filter((e) => e.type === "trial-started");
  const synthetic = manifest.mode !== "live";
  selected ??= manifest.contestants[0]?.id;
  $("#task-name").textContent = manifest.task.id;
  $("#mode").textContent =
    manifest.mode === "simulated"
      ? "SIMULATED · FIXTURES"
      : manifest.mode === "mock"
        ? "MOCK PROVIDER · REAL CLIS"
        : "LIVE";
  $("#disclosure").textContent = synthetic
    ? manifest.simulatedNotice
    : "Provider usage and dated cost estimates. Missing usage is unknown; provider billing has not been independently calibrated.";
  const meta = [
    ["Track", manifest.track === "controlled-same-model" ? "Same model" : "Practical defaults"],
    ["Revision", manifest.sourceCommit.slice(0, 12) + (manifest.sourceDirty ? " · modified" : "")],
    ["Repetitions", String(manifest.trials)],
    ["Seed", String(manifest.seed)],
  ];
  $("#run-meta").replaceChildren(
    ...meta.map(([label, value]) => {
      const d = node("div");
      d.append(node("dt", "", label), node("dd", "", value));
      return d;
    }),
  );
  $("#run-status").textContent =
    cursor === Infinity
      ? state.complete
        ? "Run complete"
        : "Recording · incomplete run"
      : "Replay";
  $("#event-count").textContent = `${events.length} / ${all.length} events`;
  $("#scrub").max = Math.max(0, all.length - 1);
  $("#scrub").value = Math.max(0, Math.min(cursor, all.length - 1));
  $("#play").disabled = cursor === Infinity;
  $("#play").textContent = playing ? "Pause" : "Play";
  $("#attempt-count").textContent = `${results.length} settled / ${starts.length} started`;

  const summaries = aggregate(results);
  const rows = [];
  for (const c of manifest.contestants) {
    const groups = summaries.filter((g) => g.contestant === c.id);
    if (!groups.length) groups.push(null);
    for (const g of groups) {
      const attempts = results.filter(
        (r) => r.contestant === c.id && r.comparable === g?.comparable,
      );
      const tr = node(
        "tr",
        `${selected === c.id ? "selected" : ""}${g && !g.comparable ? " excluded" : ""}`,
      );
      const button = node("button", "implementation", c.name ?? c.id);
      button.setAttribute("aria-pressed", String(selected === c.id));
      button.onclick = () => {
        selected = c.id;
        selectedTrial = attempts.at(-1)?.id;
        render();
      };
      const identity = cell(tr);
      identity.append(button, node("small", "", c.version));
      const models = [
        ...new Set(
          attempts.flatMap((r) =>
            [...r.ledger.sessions, ...r.ledger.receipts].map((s) => modelName(s.model)),
          ),
        ),
      ];
      const modelCell = cell(tr);
      for (const model of models) modelCell.append(node("small", "", model));
      if (!models.length) modelCell.textContent = "Pending";
      cell(
        tr,
        !g
          ? "Pending"
          : g.comparable
            ? manifest.track === "controlled-same-model"
              ? "Same model"
              : "Defaults"
            : "Excluded: model mismatch",
        "cohort",
      );
      cell(tr, g ? `${g.successes} / ${g.attempts}` : "—");
      const knownTokens =
        attempts.length && attempts.every((r) => r.ledger.totals.totalTokens !== null);
      cell(
        tr,
        g
          ? knownTokens
            ? count(attempts.reduce((n, r) => n + r.ledger.totals.totalTokens, 0))
            : "unknown"
          : "—",
      );
      cell(
        tr,
        g
          ? count(
              attempts.reduce(
                (n, r) => n + r.ledger.receipts.filter((x) => x.kind === "retry").length,
                0,
              ),
            )
          : "—",
      );
      cell(
        tr,
        !g ? "—" : g.costUsd === null ? `unknown (≥${money(g.knownCostUsd)})` : money(g.costUsd),
      );
      cell(
        tr,
        !g
          ? "—"
          : g.costUsd === null
            ? "unknown"
            : !g.successes
              ? "undefined"
              : money(g.costPerSuccessUsd),
      );
      cell(tr, g ? seconds(g.totalElapsedMs) : "—");
      rows.push(tr);
    }
  }
  $("#results").replaceChildren(...rows);

  const c = manifest.contestants.find((c) => c.id === selected);
  const available = starts.filter((e) => e.data.contestant === selected);
  const start = available.find((e) => e.trial === selectedTrial) ?? available.at(-1);
  const trial = start?.trial;
  const result = results.find((r) => r.id === trial);
  $("#selected-name").textContent = c?.name ?? selected ?? "Select an implementation";
  $("#attempt").replaceChildren(
    ...available.map((e) => {
      const r = results.find((r) => r.id === e.trial);
      const option = node(
        "option",
        "",
        `${e.data.repetition} · ${r?.status ?? "running"}${r && !r.comparable ? " · excluded" : ""}`,
      );
      option.value = e.trial;
      return option;
    }),
  );
  $("#attempt").disabled = !available.length;
  $("#attempt").value = trial ?? "";
  const status = $("#attempt-status");
  status.classList.toggle(
    "failed",
    !!result && (result.status !== "completed" || !result.quality?.success),
  );
  status.textContent = result
    ? `${result.status} · ${result.quality ? `${result.quality.passed}/${result.quality.total} checks passed` : "No graded candidate"}${result.reason ? ` · ${result.reason}` : ""}${!result.comparable ? " · Excluded from controlled comparison: model mismatch" : ""}`
    : start
      ? "Running · results are partial"
      : "This implementation has not started.";
  $("#attempt-metrics").replaceChildren(
    ...[
      ["Checks passed", result?.quality ? `${result.quality.passed}/${result.quality.total}` : "—"],
      ["Tokens", result ? count(result.ledger.totals.totalTokens) : "—"],
      [
        synthetic ? "Synthetic cost" : "Recorded cost",
        result ? money(result.ledger.totals.costUsd) : "—",
      ],
      ["Generation", result ? seconds(result.generationMs) : "—"],
      ["Verification / freeze", result ? seconds(result.verificationMs) : "—"],
      ["Total elapsed", result ? seconds(result.elapsedMs) : "—"],
    ].map(([label, value]) => metric(label, value)),
  );

  const activity = events.filter((e) => e.trial === trial && e.type === "protocol");
  const sessions = activity.filter((e) => e.data.type === "session-open");
  $("#sessions").replaceChildren(
    ...(sessions.length
      ? sessions.map(({ data: s }) => {
          const receipts = [
            ...new Map(
              activity
                .filter((e) => e.data.type === "usage" && e.data.session === s.id)
                .map((e) => [e.data.id, e.data]),
            ).values(),
          ];
          const closed = activity.find(
            (e) => e.data.type === "session-close" && e.data.id === s.id,
          )?.data;
          const complete = closed?.usageComplete && receipts.length > 0;
          const cost = receipts.reduce((n, r) => n + (r.meters.costUsd ?? 0), 0);
          const tokens =
            complete && receipts.every((r) => r.meters.totalTokens !== null)
              ? receipts.reduce((n, r) => n + r.meters.totalTokens, 0)
              : null;
          const row = node("div", `session${s.parent ? " child" : ""}`);
          row.title = s.id;
          const identity = node(
            "div",
            "",
            `${s.parent ? "↳ " : ""}${s.role} · ${closed?.status ?? (closed ? "closed" : "open")}`,
          );
          identity.append(node("small", "", modelName(s.model)));
          const receipt = node(
            "div",
            "receipt",
            complete && receipts.every((r) => r.meters.costUsd !== null)
              ? money(cost)
              : `unknown · ≥${money(cost)}`,
          );
          receipt.append(
            node("small", "", `${count(tokens)} tokens · ${receipts.length} receipts`),
          );
          row.append(identity, receipt);
          return row;
        })
      : [node("p", "muted", "No sessions recorded yet.")]),
  );

  const timeline = events
    .filter(
      (e) =>
        e.trial === trial &&
        (e.type !== "protocol" ||
          ["phase", "session-open", "session-close", "terminal"].includes(e.data.type)),
    )
    .reverse();
  $("#timeline-count").textContent = `${timeline.length} events`;
  $("#timeline").replaceChildren(
    ...timeline.map((e) => {
      const li = node("li");
      const body = node("div");
      body.append(
        node(
          "strong",
          "",
          e.type === "protocol" ? (e.data.phase ?? e.data.type) : e.type.replaceAll("-", " "),
        ),
        document.createElement("br"),
        node(
          "span",
          "",
          e.data.detail ??
            e.data.reason ??
            e.data.role ??
            (e.type === "verified"
              ? `${e.data.passed}/${e.data.total} checks passed`
              : e.type === "patch-frozen"
                ? "Candidate saved"
                : (e.data.status ?? "")),
        ),
      );
      li.append(node("time", "", `+${seconds(e.at - start.at)}`), body);
      return li;
    }),
  );
  // Preserve an open diff across polling. A selection/replay change discards it.
  const key = `${trial}/${result?.patch?.sha256 ?? "pending"}`;
  if (key !== detailKey) {
    detailKey = key;
    const patch = $("#patch");
    patch.replaceChildren();
    if (result?.patch) {
      const url = `/artifact/${result.id}/final.patch`;
      const link = node("a", "", "Download patch ↗");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      const details = node("details");
      const pre = node("pre", "", "Loading patch…");
      details.append(node("summary", "", "View diff"), pre);
      let loaded = false;
      details.ontoggle = async () => {
        if (!details.open || loaded) return;
        try {
          const response = await fetch(url);
          if (!response.ok) throw Error();
          const text = await response.text();
          if (detailKey === key) {
            pre.textContent = text;
            loaded = true;
          }
        } catch {
          pre.textContent = "Patch unavailable. Close and reopen to retry.";
        }
      };
      patch.append(link, node("p", "", `Candidate SHA-256 ${result.patch.sha256}`), details);
    } else patch.append(node("p", "", "No frozen patch available."));
  }
  $("#provenance").textContent =
    `Source ${manifest.sourceCommit.slice(0, 12)} · task ${manifest.task.sha256.slice(0, 12)} · ${manifest.node}`;
}
$("#attempt").onchange = (e) => {
  selectedTrial = e.target.value;
  render();
};
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
    $("#disclosure").textContent = state
      ? "Connection lost. Showing the last received events."
      : "Waiting for a readable event log. Start the runner in another terminal.";
  }
}
await refresh();
setInterval(refresh, 1000);
requestAnimationFrame(animate);

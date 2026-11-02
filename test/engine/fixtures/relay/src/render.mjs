function escapeTableCell(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function escapeLineBreaks(value) {
  return String(value).replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

export function renderReport(summary, errors = []) {
  const lines = [
    "# Relay incident report",
    "",
    `Events: ${summary.total} | Failures: ${summary.failures} | Invalid lines: ${errors.length}`,
    "",
    "| Service | Events | Failures | Error rate | p95 (ms) |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];

  for (const service of summary.services) {
    lines.push(
      `| ${escapeTableCell(service.service)} | ${service.count} | ${service.failures} | ${(service.errorRate * 100).toFixed(1)}% | ${service.p95Ms.toFixed(1)} |`,
    );
  }

  if (summary.services.length === 0) {
    lines.push("No valid events.");
  }

  if (errors.length > 0) {
    lines.push(
      "",
      "## Invalid lines",
      ...errors.map(
        (error) => `- Line ${error.line}: ${escapeLineBreaks(error.message)}`,
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}

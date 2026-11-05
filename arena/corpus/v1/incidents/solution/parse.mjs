export function parseLine(line) {
  if (typeof line !== "string") return null;
  const parts = line.split("|");
  if (parts.length < 4) return null;
  const [rawTimestamp, level, rawService, ...messageParts] = parts;
  if (rawTimestamp.trim() !== rawTimestamp || !/^(?:0|[1-9]\d*)$/.test(rawTimestamp)) return null;
  const timestamp = Number(rawTimestamp);
  const service = rawService.trim();
  if (!Number.isSafeInteger(timestamp) || !["INFO", "WARN", "ERROR"].includes(level) || !service)
    return null;
  return { timestamp, level, service, message: messageParts.join("|") };
}

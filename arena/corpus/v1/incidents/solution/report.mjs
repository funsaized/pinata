import { parseLine } from "./parse.mjs";
import { aggregate } from "./aggregate.mjs";

export function summarize(lines, start, end) {
  if (!Array.isArray(lines)) throw new TypeError("lines must be an array");
  const events = [];
  let malformed = 0;
  for (const line of lines) {
    const event = parseLine(line);
    if (event === null) malformed += 1;
    else events.push(event);
  }
  const services = aggregate(events, start, end);
  const accepted = services.reduce(
    (sum, service) => sum + service.info + service.warn + service.error,
    0,
  );
  const alerts = services
    .filter((service) => service.error >= 2 || service.warn >= 3)
    .map((service) => ({
      service: service.service,
      severity: service.error >= 2 ? "critical" : "warning",
    }));
  return { accepted, malformed, outsideWindow: events.length - accepted, services, alerts };
}

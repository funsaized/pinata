export function aggregate(events, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new TypeError("invalid window");
  }
  const services = new Map();
  for (const event of events) {
    if (event.timestamp < start || event.timestamp >= end) continue;
    const counts = services.get(event.service) ?? {
      service: event.service,
      info: 0,
      warn: 0,
      error: 0,
    };
    counts[event.level.toLowerCase()] += 1;
    services.set(event.service, counts);
  }
  return [...services.keys()].sort().map((service) => services.get(service));
}

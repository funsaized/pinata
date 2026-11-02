export function summarize(events) {
  const byService = new Map();
  let failures = 0;

  for (const event of events) {
    let serviceSummary = byService.get(event.service);
    if (serviceSummary === undefined) {
      serviceSummary = {
        service: event.service,
        count: 0,
        failures: 0,
        latencies: [],
      };
      byService.set(event.service, serviceSummary);
    }

    serviceSummary.count += 1;
    serviceSummary.latencies.push(event.latencyMs);
    if (event.status >= 500) {
      serviceSummary.failures += 1;
      failures += 1;
    }
  }

  const services = [...byService.values()].map(
    ({ service, count, failures: serviceFailures, latencies }) => {
      latencies.sort((a, b) => a - b);
      const p95Rank = Math.ceil(0.95 * count);

      return {
        service,
        count,
        failures: serviceFailures,
        errorRate: serviceFailures / count,
        p95Ms: latencies[p95Rank - 1],
      };
    },
  );
  services.sort((left, right) =>
    left.service < right.service ? -1 : left.service > right.service ? 1 : 0,
  );

  return { total: events.length, failures, services };
}

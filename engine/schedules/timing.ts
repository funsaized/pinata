import { CronExpressionParser } from "cron-parser";
import { DomainError } from "../contracts/common.ts";
import { triggerSchema } from "../contracts/commands.ts";
import type { ScheduleState } from "../contracts/schedule.ts";

type Trigger = ScheduleState["trigger"];
export function normalizeTrigger(input: Trigger): Trigger {
  const trigger = triggerSchema.parse(input);
  if (trigger.kind === "at") return { kind: "at", at: new Date(trigger.at).toISOString() };
  if (trigger.kind === "interval") return trigger;
  const expression = trigger.expression.trim().replace(/\s+/g, " ");
  if (expression.split(" ").length !== 5 || /@/.test(expression) || /\bH\b/i.test(expression))
    throw new DomainError(
      "invalid_input",
      "Cron requires five deterministic fields without aliases or randomized H fields",
    );
  try {
    new Intl.DateTimeFormat("en", { timeZone: trigger.timezone }).format();
    CronExpressionParser.parse(expression, { tz: trigger.timezone });
  } catch (cause) {
    throw new DomainError(
      "invalid_input",
      `Invalid cron expression or IANA timezone: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return { ...trigger, expression };
}

export function localMinute(at: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
}

export function nextOccurrence(
  trigger: Trigger,
  after: string,
  lastLocalKey?: string | readonly string[],
): string | null {
  if (trigger.kind === "at") return Date.parse(trigger.at) > Date.parse(after) ? trigger.at : null;
  if (trigger.kind === "interval")
    return new Date(Date.parse(after) + trigger.milliseconds).toISOString();
  const previous = new Set(
    typeof lastLocalKey === "string" ? [lastLocalKey] : (lastLocalKey ?? []),
  );
  try {
    const parsed = CronExpressionParser.parse(trigger.expression, {
      currentDate: after,
      tz: trigger.timezone,
    });
    // cron-parser shifts a missing spring-forward wall time into the next hour.
    // Filter it against the requested wall fields instead; a repeated wall minute
    // is retained once using its recorded local identity across fresh iterators.
    for (let attempt = 0; attempt < 100_000; attempt++) {
      const candidate = parsed.next().toISOString();
      if (!candidate) throw new DomainError("invalid_input", "Cron produced an invalid timestamp");
      const key = localMinute(candidate, trigger.timezone);
      const hour = Number(key.slice(11, 13));
      const minute = Number(key.slice(14, 16));
      if (
        parsed.fields.hour.values.some((value) => value === hour) &&
        parsed.fields.minute.values.some((value) => value === minute) &&
        !previous.has(key)
      )
        return candidate;
    }
    throw new DomainError("invalid_input", "Cron has no supported next occurrence");
  } catch (cause) {
    if (cause instanceof DomainError) throw cause;
    throw new DomainError(
      "invalid_input",
      `Cron has no supported next occurrence: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

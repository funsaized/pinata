const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:[Zz]|([+-])(\d{2})(?::?(\d{2}))?)$/;

function isValidTimestamp(value) {
  if (typeof value !== "string") return false;

  const match = ISO_TIMESTAMP.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);

  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHour > 23 || offsetMinute > 59) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

function validateEvent(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "record must be a JSON object";
  }
  if (typeof value.service !== "string" || value.service.length === 0) {
    return "service must be a nonempty string";
  }
  if (!isValidTimestamp(value.at)) {
    return "at must be a valid ISO timestamp with a timezone";
  }
  if (!Number.isInteger(value.status) || value.status < 100 || value.status > 599) {
    return "status must be an integer from 100 through 599";
  }
  if (typeof value.latencyMs !== "number" || !Number.isFinite(value.latencyMs) || value.latencyMs < 0) {
    return "latencyMs must be a finite nonnegative number";
  }
  return null;
}

export function parseEvents(text) {
  if (typeof text !== "string") {
    throw new TypeError("parseEvents expects a string");
  }

  const events = [];
  const errors = [];
  const lines = text.split(/\r\n|\n|\r/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;

    let value;
    try {
      value = JSON.parse(line);
    } catch {
      errors.push({ line: index + 1, message: "line is not valid JSON" });
      continue;
    }

    const validationError = validateEvent(value);
    if (validationError !== null) {
      errors.push({ line: index + 1, message: validationError });
      continue;
    }

    events.push({
      service: value.service,
      at: value.at,
      status: value.status,
      latencyMs: value.latencyMs,
    });
  }

  return { events, errors };
}


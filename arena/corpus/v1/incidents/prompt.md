# Windowed incident summary

Implement the three ESM modules without dependencies or input mutation.

`parse.mjs`: `parseLine(line)` parses `timestamp|level|service|message`. A valid
timestamp is `0` or a nonzero digit followed by digits, representing a nonnegative
safe integer (milliseconds); reject signs, whitespace, leading zeroes, and decimal
or exponent notation. Level must be exactly INFO, WARN, or ERROR. Trim service
whitespace and require a nonempty result. Preserve message verbatim, including
additional `|` characters; an empty message is valid. Return
`{timestamp, level, service, message}`. Return null for any malformed line or
nonstring, instead of throwing.

`aggregate.mjs`: `aggregate(events, start, end)` accepts already parsed valid
events and nonnegative safe-integer start/end bounds, with start <= end. Throw
TypeError for invalid bounds. The window is half-open: start <= timestamp < end.
Return an array of `{service, info, warn, error}`, with all three counts always
present, sorted by service using JavaScript's default ASCII/UTF-16 string order.
Only services with in-window events appear. Service names are case-sensitive.
Do not deduplicate repeated events. Empty and zero-width windows return [].
The events array and its objects are guaranteed valid.

`report.mjs`: `summarize(lines, start, end)` accepts an array of raw log lines;
throw TypeError if lines is not an array or bounds are invalid (even on empty
input). Return `{accepted, malformed, outsideWindow, services, alerts}`.
`accepted` counts valid in-window lines; `malformed` counts all lines parseLine
rejects; `outsideWindow` counts valid lines outside the window. `services` is
aggregate's complete result. `alerts`, in the same service order, contains
`{service, severity}` for services with error >= 2 (severity "critical") or,
otherwise, warn >= 3 (severity "warning"). Critical takes precedence when both
thresholds hold; all other services have no alert. For example, two ERROR lines
for api at timestamps 10 and 20 produce a critical alert in [10, 30), but only
one accepted event and no alert in [10, 20).

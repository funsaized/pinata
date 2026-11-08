// Runtime callers and hooks receive their own immutable value, never a mutable projection.
export function immutable<T>(value: T): T {
  return freeze(structuredClone(value));
}

function freeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

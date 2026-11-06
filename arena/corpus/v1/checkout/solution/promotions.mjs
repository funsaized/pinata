export function discountFor(subtotalCents, code) {
  if (
    !Number.isSafeInteger(subtotalCents) ||
    subtotalCents < 0 ||
    (code !== undefined && typeof code !== "string")
  )
    throw new TypeError("invalid promotion input");
  switch ((code ?? "").trim().toUpperCase()) {
    case "SAVE10":
      return Math.min(subtotalCents, 500, Math.floor(subtotalCents / 10));
    case "LESS300":
      return subtotalCents >= 2000 ? 300 : 0;
    default:
      return 0;
  }
}

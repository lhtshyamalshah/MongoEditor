// Readable Extended JSON for the document editor. Works on canonical Extended
// JSON and only unwraps a value when EJSON.parse(..., { relaxed: false })
// turns the plain form back into the same BSON type.
export function compactEjson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactEjson);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length === 1) {
    const raw = object[keys[0]];
    // Plain integers parse as Int32 when they fit, so every Int32 can unwrap.
    if (keys[0] === "$numberInt") return Number(raw);
    // Plain integers outside Int32 parse as Int64. Beyond 2^53 they lose precision.
    if (keys[0] === "$numberLong") {
      const number = Number(raw);
      return Number.isSafeInteger(number) &&
        (number > 2147483647 || number < -2147483648)
        ? number
        : object;
    }
    // Whole-number doubles such as 25000.0 would come back as integers.
    if (keys[0] === "$numberDouble") {
      const number = Number(raw);
      return Number.isFinite(number) && !Number.isInteger(number)
        ? number
        : object;
    }
    if (keys[0] === "$date") {
      const date = new Date(
        Number((raw as { $numberLong?: string })?.$numberLong ?? raw),
      );
      const year = date.getUTCFullYear();
      return year >= 1970 && year <= 9999
        ? { $date: date.toISOString() }
        : object;
    }
    if (keys[0].startsWith("$")) return object;
  }
  return Object.fromEntries(
    keys.map((key) => [key, compactEjson(object[key])]),
  );
}

export const valueTypes = [
  "string",
  "int",
  "long",
  "double",
  "decimal",
  "boolean",
  "date",
  "objectId",
  "null",
  "json",
] as const;
export type ValueType = (typeof valueTypes)[number];
export const operators = {
  eq: "Equals",
  ne: "Does not equal",
  contains: "Contains text",
  gt: "Greater than",
  gte: "Greater than or equal",
  lt: "Less than",
  lte: "Less than or equal",
  exists: "Exists",
  missing: "Is missing",
};
export type Operator = keyof typeof operators;

export function buildFieldFilter(
  path: string,
  operator: Operator,
  type: ValueType,
  text: string,
): Record<string, unknown> {
  if (
    !path ||
    path.length > 255 ||
    path.includes("\0") ||
    path.split(".").some((part) => !part || part.startsWith("$"))
  )
    throw new Error("Choose a valid field path.");
  if (!Object.hasOwn(operators, operator))
    throw new Error("Choose a valid operator.");
  if (operator === "exists" || operator === "missing")
    return { [path]: { $exists: operator === "exists" } };
  if (operator === "contains") {
    if (type !== "string")
      throw new Error("Contains text requires a string value.");
    if (!text) throw new Error("Enter text to search for.");
    return {
      [path]: {
        $regex: text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        $options: "i",
      },
    };
  }
  if (
    !["eq", "ne"].includes(operator) &&
    ![
      "string",
      "int",
      "long",
      "double",
      "decimal",
      "date",
      "objectId",
    ].includes(type)
  )
    throw new Error("Use Equals or Does not equal for this value type.");
  let value: unknown;
  const trimmed = text.trim();
  switch (type) {
    case "string":
      value = text;
      break;
    case "int":
      if (
        !/^-?\d+$/.test(trimmed) ||
        Number(trimmed) < -2147483648 ||
        Number(trimmed) > 2147483647
      )
        throw new Error("Enter an integer between -2147483648 and 2147483647.");
      value = { $numberInt: String(Number(trimmed)) };
      break;
    case "long":
      if (
        !/^-?\d+$/.test(trimmed) ||
        BigInt(trimmed) < -(2n ** 63n) ||
        BigInt(trimmed) > 2n ** 63n - 1n
      )
        throw new Error("Enter a valid 64-bit integer.");
      value = { $numberLong: BigInt(trimmed).toString() };
      break;
    case "double":
    case "decimal":
      if (
        !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed) ||
        (type === "double" && !Number.isFinite(Number(trimmed)))
      )
        throw new Error("Enter a valid number.");
      value =
        type === "decimal"
          ? { $numberDecimal: trimmed }
          : { $numberDouble: trimmed };
      break;
    case "boolean":
      if (!["true", "false"].includes(trimmed))
        throw new Error("Choose true or false.");
      value = trimmed === "true";
      break;
    case "objectId":
      if (!/^[a-f\d]{24}$/i.test(trimmed))
        throw new Error("Enter a 24-character hexadecimal ObjectId.");
      value = { $oid: trimmed };
      break;
    case "date": {
      if (
        !/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/.test(trimmed) ||
        !Number.isFinite(Date.parse(trimmed))
      )
        throw new Error(
          "Enter a date (YYYY-MM-DD) or an ISO timestamp with a timezone.",
        );
      value = { $date: new Date(trimmed).toISOString() };
      break;
    }
    case "null":
      value = null;
      break;
    case "json":
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error("Enter valid JSON or MongoDB Extended JSON.");
      }
      break;
    default:
      throw new Error("Choose a valid value type.");
  }
  // Always wrap equality so object values cannot become query operators.
  return {
    [path]: {
      [`$${operator}`]: value,
      ...(value === null && operator === "eq" ? { $exists: true } : {}),
    },
  };
}

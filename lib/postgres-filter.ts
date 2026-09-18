export type PgColumn = { name: string; type: string; nullable: boolean; primaryKey: boolean; generated: boolean };
export type PgSchema = { columns: PgColumn[]; readOnly: boolean; reason: string };

export function quoteIdentifier(value: string) {
  if (!value || value.includes("\0")) throw new Error("Invalid SQL identifier.");
  return `"${value.replace(/"/g, '""')}"`;
}

// Only this small, explicit filter language is translated to SQL. All values
// stay in bind parameters; identifiers must match catalog column names.
export function compileFilter(filter: Record<string, unknown>, columns: PgColumn[]) {
  const values: unknown[] = [];
  const clauses: string[] = [];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  for (const [field, condition] of Object.entries(filter)) {
    if (!columns.some(column => column.name === field)) throw new Error(`Unknown column: ${field}`);
    const name = quoteIdentifier(field);
    const operators = condition !== null && typeof condition === "object" && !Array.isArray(condition) ? condition : { $eq: condition };
    if (!Object.keys(operators).length) throw new Error("A filter must contain an operator.");
    for (const [op, value] of Object.entries(operators)) {
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new Error("Filter values must be strings, numbers, booleans, or null. Use strings for SQL arrays and JSON.");
      if (value === null) {
        if (!["$eq", "$ne"].includes(op)) throw new Error("Use $eq or $ne with null.");
        clauses.push(`${name} IS ${op === "$ne" ? "NOT " : ""}NULL`);
      } else if (op === "$contains") {
        if (typeof value !== "string") throw new Error("$contains requires text.");
        clauses.push(`${name}::text ILIKE ${bind(`%${value.replace(/[\\%_]/g, "\\$&")}%`)} ESCAPE E'\\\\'`);
      } else {
        const allowed: Record<string, string> = { $eq: "=", $ne: "<>", $gt: ">", $gte: ">=", $lt: "<", $lte: "<=" };
        if (!Object.hasOwn(allowed, op)) throw new Error(`Unsupported PostgreSQL filter operator: ${op}`);
        const operator = allowed[op];
        clauses.push(`${name} ${operator} ${bind(value)}`);
      }
    }
  }
  return { sql: clauses.length ? clauses.join(" AND ") : "TRUE", values };
}

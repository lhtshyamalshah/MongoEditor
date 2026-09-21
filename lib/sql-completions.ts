import type { SQLNamespace } from "@codemirror/lang-sql";
import { quoteIdentifier, type PgSchema } from "./postgres-filter";
import type { SqlTable } from "./sql-editor";

export function completionNamespace(
  tables: SqlTable[],
  metadata: Record<string, PgSchema>,
): SQLNamespace {
  const schemas = new Map<string, Record<string, SQLNamespace>>();
  for (const table of tables) {
    if (!table.schema || !table.table) continue;
    let children = schemas.get(table.schema);
    if (!children) {
      children = Object.create(null) as Record<string, SQLNamespace>;
      schemas.set(table.schema, children);
    }
    // CodeMirror uses dots as namespace separators even in object keys.
    children[table.table.replace(/\./g, "\\.")] = {
      self: {
        label: table.table,
        type: "type",
        apply: quoteIdentifier(table.table),
      },
      children: (metadata[table.name]?.columns || []).map((column) => ({
        label: column.name,
        type: "property",
        apply: quoteIdentifier(column.name),
        detail: column.type,
        info: `${column.type}${column.primaryKey ? " · primary key" : ""}${column.nullable ? " · nullable" : " · not null"}`,
      })),
    };
  }
  return Object.fromEntries(
    [...schemas].map(([name, children]) => [
      name.replace(/\./g, "\\."),
      {
        self: { label: name, type: "namespace", apply: quoteIdentifier(name) },
        children,
      },
    ]),
  );
}

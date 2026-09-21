export type SchemaField = {
  path: string;
  types: string[];
  itemTypes: string[];
  present: number;
};
export type CollectionSchema = {
  fields: SchemaField[];
  sampled: number;
  limited: boolean;
};

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (value && typeof value === "object" && "_bsontype" in value) {
    const names: Record<string, string> = {
      ObjectId: "objectId",
      Int32: "int",
      Long: "long",
      Double: "double",
      Decimal128: "decimal",
      Binary: "binary",
      BSONRegExp: "regex",
      Timestamp: "timestamp",
    };
    return names[String(value._bsontype)] || String(value._bsontype);
  }
  if (typeof value === "number") return "double";
  return typeof value;
}

// Presence is counted once per document, including fields inside arrays.
// Values are never included in the schema response.
export function inferSchema(
  documents: Record<string, unknown>[],
): CollectionSchema {
  const fields = new Map<
    string,
    { types: Set<string>; itemTypes: Set<string>; present: number }
  >();
  let limited = false;
  for (const document of documents) {
    const seen = new Set<string>();
    function visit(
      value: unknown,
      path: string,
      depth: number,
      arrayItem = false,
    ) {
      if (depth > 8) {
        limited = true;
        return;
      }
      let field = fields.get(path);
      if (!field) {
        if (fields.size >= 500) {
          limited = true;
          return;
        }
        field = { types: new Set(), itemTypes: new Set(), present: 0 };
        fields.set(path, field);
      }
      if (!seen.has(path)) {
        seen.add(path);
        field.present++;
      }
      const type = valueType(value);
      (arrayItem ? field.itemTypes : field.types).add(type);
      if (Array.isArray(value)) {
        if (value.length > 50) limited = true;
        for (const item of value.slice(0, 50))
          visit(item, path, depth + 1, true);
      } else if (type === "object") {
        for (const [key, child] of Object.entries(
          value as Record<string, unknown>,
        )) {
          if (key.startsWith("$") || key.includes(".") || key.includes("\0")) {
            limited = true;
            continue;
          }
          visit(child, `${path}.${key}`, depth + 1);
        }
      }
    }
    for (const [key, value] of Object.entries(document)) {
      if (key.startsWith("$") || key.includes(".") || key.includes("\0")) {
        limited = true;
        continue;
      }
      visit(value, key, 0);
    }
  }
  return {
    sampled: documents.length,
    limited,
    fields: [...fields]
      .map(([path, field]) => ({
        path,
        types: [...field.types].sort(),
        itemTypes: [...field.itemTypes].sort(),
        present: field.present,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

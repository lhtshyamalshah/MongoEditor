"use client";

import { useState } from "react";

type JsonObject = Record<string, unknown>;

/**
 * Format a canonical Extended JSON leaf the way MongoDB Compass shows it.
 * @returns text and a type class, or null for objects and arrays
 */
function leaf(value: unknown): { text: string; kind: string } | null {
  if (value === null) return { text: "null", kind: "null" };
  if (typeof value === "string")
    return { text: JSON.stringify(value), kind: "string" };
  if (typeof value !== "object")
    return { text: String(value), kind: typeof value };
  if (Array.isArray(value)) return null;
  const object = value as JsonObject;
  const keys = Object.keys(object);
  const raw = object[keys[0]] as JsonObject;
  switch (keys.length === 1 ? keys[0] : "") {
    case "$oid":
      return { text: `ObjectId('${object.$oid}')`, kind: "oid" };
    case "$numberInt":
    case "$numberLong":
    case "$numberDouble":
    case "$numberDecimal":
      return { text: String(raw), kind: "number" };
    case "$date": {
      const date = new Date(Number(raw?.$numberLong ?? raw));
      return {
        text: Number.isNaN(date.getTime())
          ? String(raw)
          : date.toISOString().replace("Z", "+00:00"),
        kind: "date",
      };
    }
    case "$timestamp":
      return { text: `Timestamp({ t: ${raw.t}, i: ${raw.i} })`, kind: "oid" };
    case "$regularExpression":
      return { text: `/${raw.pattern}/${raw.options}`, kind: "string" };
    case "$binary": {
      if (raw.subType === "04") {
        const hex = Array.from(atob(String(raw.base64)), (c) =>
          c.charCodeAt(0).toString(16).padStart(2, "0"),
        ).join("");
        return {
          text: `UUID('${hex.replace(/^(.{8})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4-")}')`,
          kind: "oid",
        };
      }
      return {
        text: `Binary.createFromBase64('${raw.base64}', ${parseInt(String(raw.subType), 16)})`,
        kind: "oid",
      };
    }
    case "$minKey":
      return { text: "MinKey()", kind: "oid" };
    case "$maxKey":
      return { text: "MaxKey()", kind: "oid" };
  }
  if (keys.length && keys.every((key) => key.startsWith("$")))
    return { text: JSON.stringify(value), kind: "oid" };
  return null;
}

function Field({ name, value }: { name: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  const scalar = leaf(value);
  if (scalar)
    return (
      <div className="tree-row">
        <span className="tree-key">{name}</span>
        <span className={`tree-value tree-${scalar.kind}`}>{scalar.text}</span>
      </div>
    );
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as JsonObject);
  const type = Array.isArray(value) ? "Array" : "Object";
  if (!entries.length)
    return (
      <div className="tree-row">
        <span className="tree-key">{name}</span>
        <span className="tree-value tree-type">{type} (empty)</span>
      </div>
    );
  return (
    <details
      className="tree-node"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="tree-row">
        <span className="tree-key">{name}</span>
        <span className="tree-value tree-type">
          {Array.isArray(value) ? `Array (${entries.length})` : "Object"}
        </span>
      </summary>
      {/* Children render only when expanded; large documents stay fast. */}
      {open && (
        <div className="tree-children">
          {entries.map(([key, item]) => (
            <Field key={key} name={key} value={item} />
          ))}
        </div>
      )}
    </details>
  );
}

/** Read-only, collapsible field list in the style of Compass's List view. */
export default function DocumentTree({ value }: { value: JsonObject }) {
  return (
    <div className="document-tree">
      {Object.entries(value).map(([key, item]) => (
        <Field key={key} name={key} value={item} />
      ))}
    </div>
  );
}

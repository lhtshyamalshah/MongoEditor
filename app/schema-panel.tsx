"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Braces, ChevronDown, Filter, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { buildFieldFilter, operators, valueTypes, type Operator, type ValueType } from "@/lib/field-filter";
import type { CollectionSchema, SchemaField } from "@/lib/schema";

const placeholders: Record<ValueType, string> = {
  string: "Enter a value", int: "18", long: "9223372036854775807", double: "42.5", decimal: "123.45",
  boolean: "true", date: "2026-09-11 or 2026-09-11T12:00:00Z", objectId: "507f1f77bcf86cd799439011", null: "null", json: '{ "key": "value" }'
};

export default function SchemaPanel({ token, database, collection, refresh, documentsBusy, onApply }: {
  token: string; database: string; collection: string; refresh: number; documentsBusy: boolean; onApply: (filter: Record<string, unknown>) => void;
}) {
  const [schema, setSchema] = useState<CollectionSchema | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [find, setFind] = useState("");
  const [selected, setSelected] = useState("");
  const [type, setType] = useState<ValueType>("string");
  const [operator, setOperator] = useState<Operator>("eq");
  const [value, setValue] = useState("");
  const [filterError, setFilterError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    fetch("/api/mongo", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-Mongo-Browser": "1", "X-Connection-Token": token },
      body: JSON.stringify({ action: "schema", database, collection })
    }).then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error || "Could not load the collection schema."); return result as CollectionSchema; })
      .then(result => { if (!controller.signal.aborted) setSchema(result); })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, database, collection, refresh, reload]);

  function choose(field: SchemaField) {
    const candidates = [...field.types, ...field.itemTypes];
    const nextType = candidates.find(item => item !== "null" && valueTypes.includes(item as ValueType)) as ValueType | undefined;
    setSelected(field.path); setType(nextType || (field.types.includes("null") && field.types.length === 1 ? "null" : "json"));
    setValue(nextType === "boolean" ? "true" : ""); setOperator("eq"); setFilterError("");
  }
  function changeType(next: ValueType) { setType(next); setOperator("eq"); setValue(next === "boolean" ? "true" : ""); setFilterError(""); }
  function submit(event: FormEvent) {
    event.preventDefault();
    try { const filter = buildFieldFilter(selected, operator, type, value); setFilterError(""); onApply(filter); }
    catch (error) { setFilterError((error as Error).message); }
  }
  const noValue = operator === "exists" || operator === "missing";
  const comparable = ["string", "int", "long", "double", "decimal", "date", "objectId"].includes(type);
  const visible = schema?.fields.filter(field => field.path.toLowerCase().includes(find.toLowerCase())) || [];
  let preview = "";
  if (selected) { try { preview = JSON.stringify(buildFieldFilter(selected, operator, type, value), null, 2); } catch { /* Validation appears when Apply is pressed. */ } }

  return <details className="schema-panel" open>
    <summary><Braces size={17} /><strong>Collection schema</strong><span className="document-count">{schema?.fields.length ?? "—"} fields</span><ChevronDown className="schema-chevron" size={16} /></summary>
    <div className="schema-content">
      <div className="schema-description"><p>Inferred from {schema ? schema.sampled : "up to 100"} documents, independently of your search. Other documents may have additional fields or types.</p><button className="button small secondary" disabled={loading} onClick={() => setReload(current => current + 1)}><RefreshCw size={13} className={loading ? "spin" : ""} />Refresh schema</button></div>
      {error ? <div role="alert" className="error">{error}</div> : loading ? <div className="loading" role="status"><LoaderCircle size={18} className="spin" />Reading collection fields…</div> : !schema?.fields.length ? <p className="schema-empty">No fields found. An empty collection has no document schema to infer.</p> : <div className="schema-layout">
        <div className="schema-fields"><label className="schema-field-search"><Search size={14} /><input aria-label="Find a schema field" placeholder="Find a field…" value={find} onChange={event => setFind(event.target.value)} /></label>
          <div className="schema-field-list"><table><thead><tr><th>Field path</th><th>Detected types</th><th>Present in sample</th></tr></thead><tbody>{visible.map(field => <tr key={field.path} className={selected === field.path ? "schema-selected" : ""}>
            <td><button type="button" className="schema-field-button" aria-pressed={selected === field.path} onClick={() => choose(field)} title={`Filter by ${field.path}`}><Filter size={12} /><code>{field.path}</code></button></td>
            <td><span className="schema-types">{field.types.map(item => <span className="schema-type" key={item}>{item === "array" && field.itemTypes.length ? `array<${field.itemTypes.join(" | ")}>` : item}</span>)}</span></td>
            <td>{field.present} / {schema.sampled}</td>
          </tr>)}</tbody></table>{!visible.length && <p className="schema-empty">No fields match your search.</p>}</div>
        </div>
        <form className="schema-filter" onSubmit={submit}><div className="schema-filter-title"><Filter size={15} /><h3>Filter by field</h3></div>{!selected ? <p className="schema-empty">Select a field from the schema to build a filter.</p> : <>
          <label htmlFor="schema-field">Field</label><input id="schema-field" value={selected} readOnly />
          <div className="schema-filter-row"><label>Value type<select value={type} onChange={event => changeType(event.target.value as ValueType)} disabled={noValue}>{valueTypes.map(item => <option key={item} value={item}>{item === "json" ? "JSON / Extended JSON" : item}</option>)}</select></label><label>Operator<select value={operator} onChange={event => { setOperator(event.target.value as Operator); setFilterError(""); }}>{Object.entries(operators).filter(([key]) => key !== "contains" || type === "string").filter(([key]) => !["gt", "gte", "lt", "lte"].includes(key) || comparable).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
          {!noValue && type !== "null" && <><label htmlFor="schema-value">Value</label>{type === "boolean" ? <select id="schema-value" value={value} onChange={event => setValue(event.target.value)}><option value="true">true</option><option value="false">false</option></select> : <input id="schema-value" spellCheck={false} placeholder={placeholders[type]} value={value} onChange={event => setValue(event.target.value)} />}</>}
          {preview && <pre className="schema-query" aria-label="Generated filter">{preview}</pre>}
          {filterError && <div role="alert" className="error">{filterError}</div>}
          <button className="button primary" type="submit" disabled={documentsBusy || loading}><Search size={14} />Apply filter</button><p className="field-help">Applies to the entire collection and replaces the current search. Use View all to clear it.</p>
        </>}</form>
      </div>}
      {schema?.limited && <p className="field-help schema-limit">Some fields or array items were omitted: the sample is limited to 500 field paths, 8 nesting levels, and 50 items per array. Literal field names containing dots or starting with $ require a custom query.</p>}
    </div>
  </details>;
}

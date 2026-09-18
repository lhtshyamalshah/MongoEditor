"use client";

import { useEffect, useState } from "react";
import { Braces, ChevronDown, Filter, LoaderCircle, RefreshCw, Search } from "lucide-react";
import type { PgSchema } from "@/lib/postgres-filter";

const operators = { $eq: "Equals", $ne: "Does not equal", $contains: "Contains text", $gt: "Greater than", $gte: "Greater than or equal", $lt: "Less than", $lte: "Less than or equal", null: "Is null", notNull: "Is not null" };

export default function PostgresSchemaPanel({ token, database, collection, documentsBusy, onApply }: {
  token: string; database: string; collection: string; refresh: number; documentsBusy: boolean; onApply: (filter: Record<string, unknown>) => void;
}) {
  const [schema, setSchema] = useState<PgSchema | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [find, setFind] = useState("");
  const [selected, setSelected] = useState("");
  const [operator, setOperator] = useState("$eq");
  const [value, setValue] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    fetch("/api/mongo", { method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-Mongo-Browser": "1", "X-Connection-Token": token },
      body: JSON.stringify({ action: "schema", database, collection, refresh: reload > 0 })
    }).then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error); return result as PgSchema; })
      .then(result => { if (!controller.signal.aborted) setSchema(result); })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, database, collection, reload]);
  const noValue = operator === "null" || operator === "notNull";
  const filter = { [selected]: { [noValue ? (operator === "null" ? "$eq" : "$ne") : operator]: noValue ? null : value } };
  return <details className="schema-panel" open>
    <summary><Braces size={17} /><strong>Table schema</strong><span className="document-count">{schema?.columns.length ?? "—"} columns</span><ChevronDown className="schema-chevron" size={16} /></summary>
    <div className="schema-content">
      <div className="schema-description"><p>Declared PostgreSQL column types and constraints.</p><button className="button small secondary" disabled={loading} onClick={() => setReload(current => current + 1)}><RefreshCw size={13} className={loading ? "spin" : ""} />Refresh schema</button></div>
      {schema?.reason && <p className="field-help">{schema.reason}</p>}
      {error ? <div className="error" role="alert">{error}</div> : loading ? <div className="loading" role="status"><LoaderCircle size={18} className="spin" />Reading table columns…</div> : <div className="schema-layout">
        <div className="schema-fields"><label className="schema-field-search"><Search size={14} /><input aria-label="Find a column" placeholder="Find a column…" value={find} onChange={event => setFind(event.target.value)} /></label>
          <div className="schema-field-list"><table><thead><tr><th>Column</th><th>SQL type</th><th>Constraints</th></tr></thead><tbody>{schema?.columns.filter(column => column.name.toLowerCase().includes(find.toLowerCase())).map(column => <tr key={column.name} className={selected === column.name ? "schema-selected" : ""}>
            <td><button className="schema-field-button" aria-pressed={selected === column.name} onClick={() => { setSelected(column.name); setValue(""); setOperator("$eq"); }}><Filter size={12} /><code>{column.name}</code></button></td>
            <td><span className="schema-type">{column.type}</span></td><td>{[column.primaryKey && "Primary key", column.generated && "Generated", !column.nullable && "Not null"].filter(Boolean).join(" · ") || "Nullable"}</td>
          </tr>)}</tbody></table></div>
        </div>
        <form className="schema-filter" onSubmit={event => { event.preventDefault(); if (selected) onApply(filter); }}><div className="schema-filter-title"><Filter size={15} /><h3>Filter by column</h3></div>{!selected ? <p className="schema-empty">Select a column to build a filter.</p> : <>
          <label htmlFor="pg-column">Column</label><input id="pg-column" value={selected} readOnly />
          <label htmlFor="pg-operator">Operator</label><select id="pg-operator" value={operator} onChange={event => setOperator(event.target.value)}>{Object.entries(operators).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
          {!noValue && <><label htmlFor="pg-value">Value</label><input id="pg-value" value={value} onChange={event => setValue(event.target.value)} placeholder="Value in the column's SQL type" spellCheck={false} /></>}
          <pre className="schema-query" aria-label="Generated filter">{JSON.stringify(filter, null, 2)}</pre>
          <button className="button primary" disabled={loading || documentsBusy}><Search size={14} />Apply filter</button><p className="field-help">PostgreSQL converts the value to the column type. Use View all to clear the filter.</p>
        </>}</form>
      </div>}
    </div>
  </details>;
}

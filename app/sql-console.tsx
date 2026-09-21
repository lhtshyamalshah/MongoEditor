"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Braces,
  Check,
  Copy,
  LoaderCircle,
  Play,
  RefreshCw,
  Table2,
} from "lucide-react";
import type { PgSchema } from "@/lib/postgres-filter";
import { quoteIdentifier } from "@/lib/postgres-filter";
import {
  referencedTables,
  sqlParameters,
  type SqlTable,
} from "@/lib/sql-editor";
import { completionNamespace } from "@/lib/sql-completions";
import { toCsv } from "@/lib/sql-results";
import SqlCodeEditor from "./sql-code-editor";

type QueryResult = {
  columns: { name: string; typeOid: number }[];
  rows: (string | null)[][];
  truncated: boolean;
  rowLimit: number;
  durationMs: number;
  notice: string;
};
export type SessionState = { label: string; dirty: boolean; busy: boolean };
function template(table?: SqlTable, field?: string) {
  if (!table?.schema || !table.table) return "SELECT 1 AS example;";
  return `SELECT *\nFROM ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.table)}${field ? `\nWHERE ${quoteIdentifier(field)} = $1` : ""}\nLIMIT 100;`;
}

export default function SqlConsole({
  token,
  database,
  tables,
  selected,
  active,
  blocked,
  onState,
}: {
  token: string;
  database: string;
  tables: SqlTable[];
  selected: string;
  active: boolean;
  blocked: boolean;
  onState: (state: SessionState) => void;
}) {
  const selectedTable = tables.find((table) => table.name === selected);
  const [text, setText] = useState(() => template(selectedTable));
  const opening = useRef(text);
  const [parameters, setParameters] = useState<
    Record<number, { value: string; isNull: boolean }>
  >({});
  const [rowLimit, setRowLimit] = useState(100);
  const [metadata, setMetadata] = useState<Record<string, PgSchema>>({});
  const metadataRef = useRef(metadata);
  metadataRef.current = metadata;
  const [metadataError, setMetadataError] = useState("");
  const [metadataBusy, setMetadataBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const lastReload = useRef(0);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const request = useRef<AbortController | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [view, setView] = useState<"table" | "json">("table");
  const [copied, setCopied] = useState<"json" | "csv" | "">("");
  const [executedText, setExecutedText] = useState("");
  let numbers: number[] = [],
    parameterError = "";
  try {
    numbers = sqlParameters(text, true);
  } catch (error) {
    parameterError = (error as Error).message;
  }
  const referenced = referencedTables(text, tables);
  const refs = JSON.stringify(
    [...new Set([selected, ...referenced].filter(Boolean))].slice(0, 5),
  );
  const label =
    tables.find((table) => table.name === referenced[0])?.table || "";
  const dirty = text !== opening.current;
  const report = useRef(onState);
  report.current = onState;
  useEffect(() => {
    report.current({ label, dirty, busy });
  }, [label, dirty, busy]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const refresh = reload !== lastReload.current;
    lastReload.current = reload;
    const names = (JSON.parse(refs) as string[]).filter(
      (name) => refresh || !metadataRef.current[name],
    );
    if (!names.length) return;
    const timer = setTimeout(async () => {
      setMetadataBusy(true);
      setMetadataError("");
      try {
        // Sequential and limited to referenced tables, never a whole-database
        // column crawl. The server shares its existing metadata cache.
        for (const collection of names) {
          const response = await fetch("/api/mongo", {
            method: "POST",
            signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
              "X-Mongo-Browser": "1",
              "X-Connection-Token": token,
            },
            body: JSON.stringify({
              action: "schema",
              database,
              collection,
              refresh,
            }),
          });
          const data = await response.json();
          if (!response.ok)
            throw new Error(data.error || "Could not load column suggestions.");
          if (!controller.signal.aborted)
            setMetadata((current) => ({ ...current, [collection]: data }));
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setMetadataError((error as Error).message);
      } finally {
        if (!controller.signal.aborted) setMetadataBusy(false);
      }
    }, 600);
    return () => {
      clearTimeout(timer);
      controller.abort();
      setMetadataBusy(false);
    };
  }, [token, database, refs, reload, active]);

  const namespace = useMemo(
    () => completionNamespace(tables, metadata),
    [tables, metadata],
  );
  const primaryColumn =
    metadata[selected]?.columns.find((column) => column.primaryKey) ||
    metadata[selected]?.columns[0];
  const parameterIdentity = JSON.stringify([
    text,
    numbers.map((number) => parameters[number] || { value: "", isNull: false }),
    rowLimit,
  ]);
  async function run() {
    if (!active || blocked || running.current || !text.trim() || parameterError)
      return;
    running.current = true;
    setBusy(true);
    setError("");
    setResult(null);
    setCopied("");
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await fetch("/api/mongo", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Mongo-Browser": "1",
          "X-Connection-Token": token,
        },
        body: JSON.stringify({
          action: "query",
          database,
          sql: text,
          rowLimit,
          parameters: numbers.map((number) =>
            parameters[number]?.isNull
              ? null
              : (parameters[number]?.value ?? ""),
          ),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The SQL query failed.");
      if (!controller.signal.aborted) {
        setResult(data);
        setExecutedText(parameterIdentity);
      }
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message);
    } finally {
      running.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function copy(format: "json" | "csv") {
    if (!result) return;
    const names = result.columns.map((column) => column.name);
    try {
      await navigator.clipboard.writeText(
        format === "csv"
          ? toCsv(names, result.rows)
          : JSON.stringify({ columns: names, rows: result.rows }, null, 2),
      );
      setCopied(format);
    } catch {
      setError("Clipboard access is unavailable.");
    }
  }
  function changeParameter(
    number: number,
    patch: Partial<{ value: string; isNull: boolean }>,
  ) {
    setParameters((current) => ({
      ...current,
      [number]: {
        ...(current[number] || { value: "", isNull: false }),
        ...patch,
      },
    }));
  }
  return (
    <div className="sql-console">
      <div className="sql-editor-body">
        <div className="sql-editor-actions">
          <div className="button-group">
            <button
              className="button small secondary"
              disabled={busy || !selectedTable}
              onClick={() => setText(template(selectedTable))}
            >
              SELECT selected table
            </button>
            <button
              className="button small secondary"
              disabled={busy || !primaryColumn}
              onClick={() =>
                setText(template(selectedTable, primaryColumn?.name))
              }
            >
              Parameterized example
            </button>
            <button
              className="button small secondary"
              disabled={metadataBusy || busy}
              onClick={() => setReload((current) => current + 1)}
            >
              <RefreshCw size={13} className={metadataBusy ? "spin" : ""} />
              Refresh suggestions
            </button>
          </div>
          <span className="field-help">
            Ctrl+Space: suggest · Tab: accept · Ctrl/⌘+Enter: run
          </span>
        </div>
        <SqlCodeEditor
          value={text}
          namespace={namespace}
          defaultSchema={selectedTable?.schema || "public"}
          defaultTable={selectedTable?.table}
          disabled={busy}
          onChange={setText}
          onRun={() => void run()}
        />
        <p className="field-help sql-help">
          Autocomplete suggests SQL keywords, schemas, tables, aliases, columns,
          and $1–$10 parameters. Column types load for the selected table and
          tables referenced by FROM/JOIN (up to five).{" "}
          {metadataBusy && "Loading column suggestions…"}
        </p>
        {metadataError && (
          <p className="error" role="alert">
            {metadataError} You can still write and run SQL.
          </p>
        )}
        {numbers.length > 0 && (
          <fieldset className="sql-parameters" disabled={busy}>
            <legend>Query parameters</legend>
            <p className="field-help">
              Values are bound separately from SQL. PostgreSQL infers types from
              the query; use casts such as $1::uuid when needed. Use NULL for a
              SQL null value.
            </p>
            <div className="sql-parameter-grid">
              {numbers.map((number) => (
                <div className="sql-parameter" key={number}>
                  <label htmlFor={`sql-param-${number}`}>${number}</label>
                  <input
                    id={`sql-param-${number}`}
                    aria-label={`Parameter $${number}`}
                    value={parameters[number]?.value || ""}
                    disabled={parameters[number]?.isNull}
                    placeholder="Parameter value"
                    autoComplete="off"
                    onChange={(event) =>
                      changeParameter(number, { value: event.target.value })
                    }
                  />
                  <label className="sql-null">
                    <input
                      type="checkbox"
                      checked={!!parameters[number]?.isNull}
                      onChange={(event) =>
                        changeParameter(number, {
                          isNull: event.target.checked,
                        })
                      }
                    />
                    NULL
                  </label>
                </div>
              ))}
            </div>
          </fieldset>
        )}
        {parameterError && (
          <div className="error" role="alert">
            {parameterError}
          </div>
        )}
        <div className="sql-run-bar">
          <p className="field-help">
            One SELECT or WITH query per run. Five-second timeout. No automatic
            counts or background execution.
          </p>
          <label>
            Max rows
            <select
              aria-label="SQL result limit"
              value={rowLimit}
              disabled={busy}
              onChange={(event) => setRowLimit(Number(event.target.value))}
            >
              {[25, 100, 500].map((limit) => (
                <option key={limit}>{limit}</option>
              ))}
            </select>
          </label>
          <button
            className="button primary"
            disabled={busy || blocked || !text.trim() || !!parameterError}
            onClick={() => void run()}
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Play size={16} />
            )}
            {busy ? "Running…" : "Run query"}
          </button>
        </div>
        {blocked && (
          <p className="field-help" role="status">
            Another query tab is running. One query runs per connection at a
            time.
          </p>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
      </div>
      {result && (
        <div className="sql-results">
          <div className="documents-toolbar">
            <div className="documents-title">
              <h3>Results</h3>
              <span className="document-count">
                {result.rows.length} rows · {result.durationMs} ms
              </span>
            </div>
            <div className="button-group">
              <button
                className="button small secondary"
                onClick={() =>
                  setView((current) => (current === "table" ? "json" : "table"))
                }
              >
                {view === "table" ? <Braces size={14} /> : <Table2 size={14} />}
                {view === "table" ? "JSON" : "Table"}
              </button>
              <button
                className="button small secondary"
                onClick={() => void copy("csv")}
              >
                {copied === "csv" ? <Check size={14} /> : <Copy size={14} />}
                {copied === "csv" ? "Copied" : "Copy CSV"}
              </button>
              <button
                className="button small secondary"
                onClick={() => void copy("json")}
              >
                {copied === "json" ? <Check size={14} /> : <Copy size={14} />}
                {copied === "json" ? "Copied" : "Copy JSON"}
              </button>
            </div>
          </div>
          {executedText !== parameterIdentity && (
            <p className="sql-result-notice">
              Query or parameters changed. Run again to update these results.
            </p>
          )}
          {result.notice && (
            <p className="sql-result-notice" role="status">
              {result.notice}
            </p>
          )}
          {view === "json" ? (
            <pre className="sql-json-results">
              {JSON.stringify(
                {
                  columns: result.columns.map((column) => column.name),
                  rows: result.rows,
                },
                null,
                2,
              )}
            </pre>
          ) : (
            <div className="table-scroll sql-result-table">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    {result.columns.map((column, index) => (
                      <th key={index}>{column.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, index) => (
                    <tr key={index}>
                      <td className="row-number">{index + 1}</td>
                      {row.map((value, column) => (
                        <td
                          key={column}
                          className={value === null ? "null-value" : ""}
                        >
                          <span title={value ?? "SQL NULL"}>
                            {value === null ? "NULL" : value}
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!result.rows.length && (
                <p className="schema-empty">
                  Query completed with no rows returned.
                </p>
              )}
            </div>
          )}
          <p className="field-help sql-help">
            Result values use PostgreSQL text format to preserve numeric and
            timestamp precision. SQL NULL remains null.
          </p>
        </div>
      )}
    </div>
  );
}

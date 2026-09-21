"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import dynamic from "next/dynamic";
import SchemaPanel from "./schema-panel";
import PostgresSchemaPanel from "./postgres-schema-panel";
import DatabasePicker from "./database-picker";
import PostgresTableList from "./postgres-table-list";
import { ArrowDown, ArrowLeft, ArrowRight, Braces, Check, ChevronRight, CircleHelp, Code2, Copy, Database, FileJson2, Layers3, LoaderCircle, LockKeyhole, Pencil, Plug, Plus, RefreshCw, Search, Server, ShieldCheck, Table2, Trash2, Unplug, X } from "lucide-react";

const SqlWorkspace = dynamic(() => import("./sql-workspace"), { ssr: false, loading: () => <p className="schema-empty">Loading SQL editor…</p> });

type JsonObject = Record<string, unknown>;
type Row = { value: JsonObject; revision: string; id?: JsonObject };
type CollectionInfo = { name: string; type: string; label?: string; schema?: string; table?: string; owner?: string; readOnly?: boolean };
type Connection = { backend: "mongodb" | "postgresql"; token: string; database: string; databases: string[]; label: string; notice: string };
type Results = { nextCursor?: JsonObject | null; pagination?: "keyset" | "preview"; notice?: string; readOnly?: boolean; documents: Row[]; total: number | null; hasNext: boolean; fields: string[] };
type Query = { mode: "text" | "json"; query: string; field: string };

async function api<T>(action: string, data: object = {}, token?: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/mongo", {
    method: "POST", signal, headers: { "Content-Type": "application/json", "X-Mongo-Browser": "1", ...(token ? { "X-Connection-Token": token } : {}) },
    body: JSON.stringify({ action, ...data })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The request failed. Try again.");
  return result;
}

function json(value: unknown) { return JSON.stringify(value, null, 2); }
function display(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "object") {
    const object = value as JsonObject;
    for (const key of ["$oid", "$numberInt", "$numberLong", "$numberDouble", "$numberDecimal"]) if (key in object) return String(object[key]);
    if ("$date" in object) { const date = new Date(Number(display(object.$date))); return Number.isNaN(date.getTime()) ? String(object.$date) : date.toISOString(); }
    if (Array.isArray(value)) return `[${value.length} ${value.length === 1 ? "item" : "items"}]`;
    return `{ ${Object.keys(object).slice(0, 3).join(", ")}${Object.keys(object).length > 3 ? ", …" : ""} }`;
  }
  return String(value);
}

function Highlight({ value }: { value: unknown }) {
  const text = json(value);
  const parts = text.split(/("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g);
  return <pre className="json"><code>{parts.map((part, index) => <span key={index} className={/^".*:\s*$/.test(part) ? "json-key" : part.startsWith('"') ? "json-string" : /^(true|false|null)$/.test(part) ? "json-bool" : /^-?\d/.test(part) ? "json-number" : undefined}>{part}</span>)}</code></pre>;
}

function ConnectionForm({ profiles, connection, onConnected, onCancel }: { profiles: string[]; connection: Connection | null; onConnected: (connection: Connection) => void; onCancel?: () => void }) {
  const [profile, setProfile] = useState(profiles[0] || "");
  const [uri, setUri] = useState("");
  const [showUri, setShowUri] = useState(false);
  const [database, setDatabase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { const result = await api<Connection>("connect", { profile, uri, database }, connection?.token); setUri(""); onConnected(result); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="connection-form">
    <label htmlFor="profile">Connection source</label>
    <select id="profile" value={profile} onChange={event => setProfile(event.target.value)} disabled={busy}>
      {profiles.map(item => <option key={item} value={item}>{item} · from .env</option>)}
      <option value="">Custom connection string</option>
    </select>
    {!profile && <>
      <div className="connection-uri-heading"><label htmlFor="uri">Database connection string</label><button type="button" className="connection-uri-toggle" aria-controls="uri" aria-label={showUri ? "Hide connection string" : "Show connection string"} aria-pressed={showUri} onClick={() => setShowUri(value => !value)}>{showUri ? "Hide" : "Show"}</button></div>
      {showUri
        ? <textarea id="uri" className="connection-uri-visible" rows={4} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby="uri-help" placeholder="mongodb://... or postgresql://user:password@host:5432/database" required value={uri} onChange={event => setUri(event.target.value.replace(/[\r\n]/g, ""))} disabled={busy} />
        : <input id="uri" type="password" autoComplete="off" spellCheck={false} aria-describedby="uri-help" placeholder="mongodb://... or postgresql://user:password@host:5432/database" required value={uri} onChange={event => setUri(event.target.value)} disabled={busy} />}
      <p id="uri-help" className="field-help">Accepts MongoDB and PostgreSQL URIs. Used for this session only.</p>
    </>}
    <label htmlFor="database-override">Database <span className="muted optional">optional</span></label>
    <input id="database-override" placeholder="Use the database from the connection string" value={database} onChange={event => setDatabase(event.target.value)} disabled={busy} />
    <div className="connection-note"><ShieldCheck size={17} /><span>Credentials stay on the server. DocumentDB uses your TLS certificate bundle automatically.</span></div>
    {error && <div className="error" role="alert">{error}</div>}
    <div className="form-actions">{onCancel && <button type="button" className="button secondary" onClick={onCancel} disabled={busy}>Cancel</button>}<button type="submit" className="button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Plug size={17} />}{busy ? "Connecting…" : "Connect to database"}{!busy && <ArrowRight size={16} />}</button></div>
  </form>;
}

function Modal({ children, title, onClose, wide = false }: { children: React.ReactNode; title: string; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className={wide ? "modal drawer" : "modal"} onCancel={event => { event.preventDefault(); onClose(); }} aria-label={title}>
    <div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20} /></button></div>{children}
  </dialog>;
}

function DocumentEditor({ row, postgres, readOnly, busy, error, onClose, onSave, onDelete }: { row: Row; postgres: boolean; readOnly: boolean; busy: boolean; error: string; onClose: () => void; onSave: (text: string) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(json(row.value));
  const [localError, setLocalError] = useState("");
  const [copied, setCopied] = useState(false);
  const dirty = text !== json(row.value);
  function close() { if (!busy && (!dirty || window.confirm("Discard your unsaved changes?"))) onClose(); }
  function format() { try { setText(json(JSON.parse(text))); setLocalError(""); } catch { setLocalError("The document contains invalid JSON. Check quotes, commas, and brackets."); } }
  function save() {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The document must be a JSON object.");
      if (!postgres && JSON.stringify(parsed._id) !== JSON.stringify(row.value._id)) throw new Error("The _id field cannot be changed or removed.");
      setLocalError(""); onSave(text);
    } catch (error) { setLocalError(error instanceof SyntaxError ? "The document contains invalid JSON." : (error as Error).message); }
  }
  return <Modal title={editing ? (postgres ? "Edit row" : "Edit document") : (postgres ? "Row details" : "Document details")} onClose={close} wide>
    <div className="document-meta"><span className="field-tag">{postgres ? "Primary key" : "_id"}</span><code>{postgres ? json(row.id) : display(row.value._id)}</code></div>
    <div className="editor-tools"><span className="eyebrow">{postgres ? "POSTGRESQL ROW JSON" : "MONGODB EXTENDED JSON"}</span><div className="button-group"><button className="button small secondary" disabled={busy} onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setLocalError("Clipboard access is unavailable. Select the text to copy it."); } }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Copied" : "Copy"}</button>{editing && <button className="button small secondary" onClick={format} disabled={busy}><Braces size={14} />Format</button>}</div></div>
    {editing ? <textarea className="document-textarea" aria-label="Document JSON" value={text} onChange={event => setText(event.target.value)} spellCheck={false} disabled={busy} /> : <div className="document-preview"><Highlight value={row.value} /></div>}
    <p className="editor-hint">{postgres ? "Values use PostgreSQL text format to preserve precision: keep them as JSON strings, or null for SQL NULL. Keep all columns; primary keys and generated columns cannot change." : "ObjectIds, dates, and numeric types use Extended JSON wrappers to preserve their types. The _id field is immutable."}</p>
    {(localError || error) && <div className="error" role="alert">{localError || error}</div>}
    <div className="editor-footer"><button className="button danger-quiet" disabled={busy || readOnly} onClick={() => { if (!dirty || window.confirm("Discard your unsaved changes and delete this document?")) onDelete(); }}><Trash2 size={16} />{postgres ? "Delete row" : "Delete document"}</button><div className="button-group"><button className="button secondary" onClick={close} disabled={busy}>Close</button>{!readOnly && (editing ? <button className="button primary" disabled={busy || !dirty} onClick={save}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}Save changes</button> : <button className="button primary" onClick={() => setEditing(true)}><Pencil size={16} />{postgres ? "Edit row" : "Edit document"}</button>)}</div></div>
  </Modal>;
}

export default function Home() {
  const [profiles, setProfiles] = useState<string[] | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [database, setDatabase] = useState("");
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [collection, setCollection] = useState("");
  const [collectionSearch, setCollectionSearch] = useState("");
  const [collectionsBusy, setCollectionsBusy] = useState(false);
  const [collectionError, setCollectionError] = useState("");
  const [query, setQuery] = useState<Query>({ mode: "text", query: "", field: "" });
  const [applied, setApplied] = useState<Query>(query);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [cursors, setCursors] = useState<{ key: string; pages: Record<number, JsonObject> }>({ key: "", pages: {} });
  const [refresh, setRefresh] = useState(0);
  const [collectionRefresh, setCollectionRefresh] = useState(0);
  const [results, setResults] = useState<Results | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<"table" | "json">("table");
  const [selected, setSelected] = useState<Row | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const [showConnection, setShowConnection] = useState(false);
  const [showDatabase, setShowDatabase] = useState(false);
  const [extraDatabases, setExtraDatabases] = useState<string[]>([]);
  const [toast, setToast] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"browse" | "sql">("browse");
  const [sqlOpened, setSqlOpened] = useState(false);
  const postgres = connection?.backend === "postgresql";
  const cursorKey = JSON.stringify([connection?.token, database, collection, applied, pageSize, refresh]);
  const after = postgres && cursors.key === cursorKey ? cursors.pages[page] : undefined;
  const currentCollection = collections.find(item => item.name === collection);
  const collectionLabel = currentCollection?.label || collection;
  const Schema = postgres ? PostgresSchemaPanel : SchemaPanel;
  const readOnly = !!results?.readOnly || !!currentCollection?.readOnly || collection.startsWith("system.") || collections.find(item => item.name === collection)?.type === "view";

  useEffect(() => { fetch("/api/mongo").then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error); setProfiles(data.profiles); }).catch(() => { setProfiles([]); setError("Could not load environment profiles. Refresh the page to retry, or enter a custom connection string."); }); }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 5000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (!connection || !database) return;
    const controller = new AbortController();
    setCollectionsBusy(true); setCollectionError(""); setCollections([]);
    api<{ collections: CollectionInfo[] }>("collections", { database, refresh: collectionRefresh > 0 }, connection.token, controller.signal)
      .then(result => setCollections(result.collections))
      .catch(error => { if (!controller.signal.aborted) setCollectionError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setCollectionsBusy(false); });
    return () => controller.abort();
  }, [connection, database, collectionRefresh]);

  useEffect(() => {
    if (!connection || !database || !collection || (postgres && workspaceMode === "sql")) return;
    const controller = new AbortController();
    setBusy(true); setError(""); setResults(null);
    api<Results>("documents", { database, collection, ...applied, page, pageSize, after }, connection.token, controller.signal)
      .then(result => { if (controller.signal.aborted) return; if (result.documents.length === 0 && page > 1) setPage(current => Math.max(1, current - 1)); else setResults(result); })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [connection, database, collection, applied, page, pageSize, refresh, after, postgres, workspaceMode]);

  function refreshRows() { if (postgres) setPage(1); setRefresh(value => value + 1); }
  function nextPage() {
    if (postgres && results?.nextCursor) setCursors(current => ({ key: cursorKey, pages: { ...(current.key === cursorKey ? current.pages : {}), [page + 1]: results.nextCursor! } }));
    setPage(value => value + 1);
  }
  function chooseCollection(value: string) {
    setCollection(value); setPage(1); setResults(null); setError(""); setSelected(null);
    const empty: Query = { mode: "text", query: "", field: "" }; setQuery(empty); setApplied(empty);
  }
  function chooseDatabase(value: string) { setDatabase(value); chooseCollection(""); setCollectionSearch(""); if (value) setExtraDatabases(current => [...new Set([...current, value])]); }
  function connected(value: Connection) { setConnection(value); chooseDatabase(value.database); setExtraDatabases([]); setShowConnection(false); setToast(`Connected to ${value.label}`); }
  function search(event: FormEvent) { event.preventDefault(); setPage(1); setApplied({ ...query }); }
  function clearSearch() { const empty = { ...query, query: "", field: "" }; setQuery(empty); setApplied(empty); setPage(1); }
  const closeEditor = useCallback(() => { setSelected(null); setMutationError(""); }, []);
  async function mutate(action: "update" | "delete", row: Row, document?: string) {
    if (!connection) return;
    setMutationBusy(true); setMutationError("");
    try {
      await api(action, { database, collection, id: JSON.stringify(postgres ? row.id : { _id: row.value._id }), revision: row.revision, document }, connection.token);
      setSelected(null); setDeleting(null); setToast(action === "update" ? "Record updated successfully" : "Record deleted"); refreshRows();
    } catch (error) { setMutationError((error as Error).message); }
    finally { setMutationBusy(false); }
  }
  const visibleCollections = collections.filter(item => [item.label || item.name, item.owner || "", item.schema || ""].join(" ").toLowerCase().includes(collectionSearch.toLowerCase()));
  const columns = postgres ? (results?.fields || []).slice(0, 6) : ["_id", ...[...new Set(results?.documents.flatMap(row => Object.keys(row.value)) || [])].filter(key => key !== "_id").slice(0, 5)];
  const filtered = !!applied.query.trim() && applied.query.trim() !== "{}";

  return <div className="app-shell">
    <header className="topbar"><a href="/" className="brand"><span className="brand-icon"><Database size={21} /></span>data<span className="brand-light">browser</span><span className="local-badge">LOCAL</span></a><div className="topbar-right"><span className="privacy"><LockKeyhole size={13} />Private workspace</span><button className="help-button" onClick={() => setShowHelp(true)}><CircleHelp size={16} />Quick guide</button></div></header>
    <aside className="sidebar">
      <div className="sidebar-top"><span className="eyebrow">WORKSPACE</span><span className={`status-dot ${connection ? "online" : ""}`} /></div>
      <button className="connection-card" onClick={() => { if (connection) setShowConnection(true); else document.getElementById("profile")?.focus(); }}><span className="server-icon"><Server size={19} /></span><span><strong>{connection?.label || "No connection"}</strong><small>{connection ? "Connected · select to change" : "Connect to get started"}</small></span><ChevronRight size={16} /></button>
      <div className="sidebar-section"><div className="section-label"><span className="eyebrow">DATABASE</span>{connection && <button className="icon-button small" aria-label="Enter a database name" onClick={() => setShowDatabase(true)}><Plus size={15} /></button>}</div><div className="database-select"><Database size={15} /><select aria-label="Select database" value={database} disabled={!connection} onChange={event => chooseDatabase(event.target.value)}>{!connection && <option value="">Select database</option>}{connection && [...new Set([...connection.databases, ...extraDatabases, database])].map(name => <option key={name}>{name}</option>)}</select></div></div>
      <div className="sidebar-section collections-section"><div className="section-label"><span className="eyebrow">{postgres ? "TABLES & VIEWS" : "COLLECTIONS"} <span className="count">{collections.length}</span></span>{connection && <button className="icon-button small" aria-label={postgres ? "Refresh tables" : "Refresh collections"} disabled={collectionsBusy} onClick={() => setCollectionRefresh(value => value + 1)}><RefreshCw size={14} className={collectionsBusy ? "spin" : ""} /></button>}</div><div className="collection-search"><Search size={14} /><input aria-label={postgres ? "Filter tables" : "Filter collections"} placeholder={postgres ? "Find a table…" : "Find a collection…"} value={collectionSearch} disabled={!connection} onChange={event => setCollectionSearch(event.target.value)} /></div>
      <nav aria-label={postgres ? "Tables" : "Collections"} className="collection-list">{collectionsBusy ? <div className="sidebar-empty"><LoaderCircle size={19} className="spin" /><span>{postgres ? "Loading tables…" : "Loading collections…"}</span></div> : collectionError ? <div className="error small-error" role="alert">{collectionError}</div> : visibleCollections.length ? postgres ? <PostgresTableList items={visibleCollections} selected={collection} search={collectionSearch} onSelect={chooseCollection} /> : visibleCollections.map(item => <button key={item.name} title={item.label || item.name} className={`collection-item ${collection === item.name ? "active" : ""}`} onClick={() => chooseCollection(item.name)}><Layers3 size={15} /><span>{item.label || item.name}</span>{item.readOnly || item.type === "view" ? <LockKeyhole size={12} /> : collection === item.name && <ChevronRight size={13} />}</button>) : <div className="sidebar-empty"><Layers3 size={23} /><span>{!connection ? "Your tables and collections will appear here" : collectionSearch ? "No matches" : postgres ? "No accessible tables in this database" : "No collections in this database"}</span></div>}</nav></div>
      <div className="sidebar-bottom"><span><span className={`status-dot ${connection ? "online" : ""}`} />{connection ? "Connection active" : "Ready to connect"}</span>{connection && <button className="icon-button" title="Disconnect" aria-label="Disconnect" onClick={async () => { try { await api("disconnect", {}, connection.token); setConnection(null); setCollections([]); chooseDatabase(""); setToast("Disconnected"); } catch (error) { setError((error as Error).message); } }}><Unplug size={15} /></button>}</div>
    </aside>
    <main className="main">
      <div className="breadcrumbs"><Database size={14} /><span>Workspace</span><ChevronRight size={13} /><span>{database || "Overview"}</span>{collection && <><ChevronRight size={13} /><strong>{collectionLabel}</strong></>}</div>
      {!connection ? <div className="welcome"><div className="welcome-copy"><div className="intro-pill"><span className="status-dot online" /> A LITTLE CLARITY FOR YOUR DATA</div><h1>Your data.<br /><span>Right where you need it.</span></h1><p>Connect MongoDB, DocumentDB, or PostgreSQL and explore your data. Find a record, make an edit, and get back to building.</p><div className="feature-list"><div><span><Layers3 size={18} /></span><div><strong>Your databases, one workspace</strong><p>Browse MongoDB collections or PostgreSQL tables.</p></div></div><div><span><Search size={18} /></span><div><strong>Find the record you need</strong><p>Search by text or build a column or field filter.</p></div></div><div><span><Pencil size={18} /></span><div><strong>Make changes with confidence</strong><p>Inspect, edit, or delete individual records.</p></div></div></div><div className="welcome-footnote"><LockKeyhole size={14} />Runs locally. Your credentials stay on your machine.</div></div><section className="connect-panel"><div className="connect-panel-icon"><Plug size={23} /></div><h2>Let’s connect</h2><p>Choose a saved connection or bring your own string.</p>{error && <div className="error" role="alert">{error}</div>}{profiles === null ? <div className="loading"><LoaderCircle className="spin" size={20} />Loading connections…</div> : <ConnectionForm profiles={profiles} connection={null} onConnected={connected} />}<div className="panel-footer"><span className="tiny-dot" />MongoDB · DocumentDB · PostgreSQL</div></section></div> : <>
        <div className="page-heading"><div><div className="eyebrow">DATA EXPLORER</div><h1>{collectionLabel || "Explore your database"}</h1><p>{collection ? "A closer look at the data that powers your application." : postgres ? "Select a table from the sidebar to view its rows." : "Select a collection from the sidebar to view its documents."}</p></div><button className="button secondary" onClick={() => setShowConnection(true)}><Plug size={16} />Change connection</button></div>
        {connection.notice && <div className="info-banner"><CircleHelp size={16} />{connection.notice}</div>}
        {postgres && <div className="workspace-tabs" aria-label="Database tools"><button className={workspaceMode === "browse" ? "selected" : ""} aria-pressed={workspaceMode === "browse"} onClick={() => setWorkspaceMode("browse")}><Table2 size={16} />Browse tables</button><button className={workspaceMode === "sql" ? "selected" : ""} aria-pressed={workspaceMode === "sql"} onClick={() => { setSqlOpened(true); setWorkspaceMode("sql"); }}><Code2 size={16} />SQL editor</button></div>}
        {postgres && sqlOpened && <div hidden={workspaceMode !== "sql"}><SqlWorkspace key={`${connection.token}:${database}`} token={connection.token} database={database} tables={collections} selected={collection} active={workspaceMode === "sql"} /></div>}
        {postgres && workspaceMode === "sql" ? null : !collection ? <div className="choose-collection"><span className="empty-icon"><Layers3 size={32} /></span><h2>{postgres ? "Start with a table" : "Start with a collection"}</h2><p>{collectionsBusy ? "Loading database objects…" : `${collections.length} ${postgres ? "tables and views" : "collections"} available in ${database}.`}</p><div className="collection-grid">{collections.slice(0, 12).map(item => <button key={item.name} onClick={() => chooseCollection(item.name)}><Layers3 size={18} /><span>{item.label || item.name}</span><ChevronRight size={16} /></button>)}</div>{!collectionsBusy && !collections.length && <button className="button secondary" onClick={() => setCollectionRefresh(value => value + 1)}><RefreshCw size={15} />{postgres ? "Refresh tables" : "Refresh collections"}</button>}</div> : <>
          <section className="documents-panel"><div className="documents-toolbar"><div className="documents-title"><FileJson2 size={18} /><h2>{postgres ? "Rows" : "Documents"}</h2><span className="document-count">{postgres ? `${results?.documents.length ?? 0} loaded` : results?.total != null ? results.total.toLocaleString() : "—"}</span>{readOnly && <span className="readonly-badge">Read only</span>}</div><div className="button-group"><div className="view-switch" aria-label={postgres ? "Row view" : "Document view"}><button className={view === "table" ? "selected" : ""} aria-pressed={view === "table"} onClick={() => setView("table")}><Table2 size={15} />Table</button><button className={view === "json" ? "selected" : ""} aria-pressed={view === "json"} onClick={() => setView("json")}><Code2 size={16} />JSON</button></div><button className="icon-button bordered" aria-label={postgres ? "Refresh rows" : "Refresh documents"} disabled={busy} onClick={() => refreshRows()}><RefreshCw size={16} className={busy ? "spin" : ""} /></button></div></div>
          <form className="search-form" onSubmit={search}><div className="query-row"><select aria-label="Search mode" value={query.mode} onChange={event => setQuery({ ...query, mode: event.target.value as Query["mode"], query: "" })}><option value="text">Text search</option><option value="json">JSON filter</option></select><div className="query-input">{query.mode === "json" ? <Braces size={17} /> : <Search size={17} />}<input aria-label={query.mode === "json" ? "JSON filter" : postgres ? "Search rows" : "Search documents"} spellCheck={false} placeholder={query.mode === "json" ? '{ "status": "active" }' : postgres ? "Search rows…" : "Search documents…"} value={query.query} onChange={event => setQuery({ ...query, query: event.target.value })} /></div><button className="button primary" type="submit" disabled={busy}><Search size={15} />Search</button><button className="button secondary view-all" type="button" onClick={clearSearch} disabled={busy}>View all</button></div><div className="search-hint">{query.mode === "text" ? <><label htmlFor="search-field">Search in</label><input id="search-field" list="search-fields" placeholder={postgres ? "Choose a column (required)" : "Detected string fields"} required={postgres && !!query.query.trim()} value={query.field} onChange={event => setQuery({ ...query, field: event.target.value })} /><datalist id="search-fields">{results?.fields.map(field => <option key={field} value={field} />)}</datalist><span>{postgres ? "Choose one column. Text contains can scan rows; prefer indexed equality or range filters on large tables." : "Fields sampled from 100 documents. Enter any field path to search it."}</span></> : <><Braces size={13} /><span>{postgres ? 'Use $eq, $ne, $gt, $gte, $lt, $lte, or $contains. Example: { "age": { "$gte": "18" } }' : <>Use MongoDB operators and Extended JSON, e.g. {'{ "_id": { "$oid": "…" } }'}.</>}</span></>}</div></form>
          <Schema key={`${connection.token}:${database}:${collection}`} token={connection.token} database={database} collection={collection} refresh={refresh} documentsBusy={busy} onApply={filter => { const next: Query = { mode: "json", query: JSON.stringify(filter), field: "" }; setQuery(next); setApplied(next); setPage(1); }} />
          {postgres && <p className="field-help">{results?.notice || "Totals are not counted. Pages load on demand using the primary key."}</p>}
          {filtered && <div className="active-filter"><span>Filtered results</span><code>{applied.query}</code><button className="icon-button small" aria-label="Clear filter" onClick={clearSearch}><X size={14} /></button></div>}
          {error ? <div className="results-empty"><div className="error" role="alert">{error}</div><button className="button secondary" onClick={() => refreshRows()}><RefreshCw size={15} />Try again</button></div> : busy ? <div className="results-empty" role="status"><LoaderCircle className="spin" size={28} /><h3>{postgres ? "Loading rows" : "Loading documents"}</h3><p>Fetching the latest data.</p></div> : !results?.documents.length ? <div className="results-empty"><Search size={30} /><h3>{filtered ? "No matching records" : "No records to display"}</h3><p>{filtered ? "Try a different search or clear your filter to see all records." : "Records will appear here when they’re added to your database."}</p>{filtered && <button className="button secondary" onClick={clearSearch}>View all records</button>}</div> : view === "table" ? <div className="table-scroll"><table><thead><tr><th className="row-number">#</th>{columns.map(column => <th key={column}><span>{column === "_id" && <span className="key-symbol">⌘</span>}{column}{column === "_id" && <ArrowDown size={12} />}</span></th>)}<th className="actions-column">Actions</th></tr></thead><tbody>{results.documents.map((row, index) => <tr key={`${row.revision}-${index}`}><td className="row-number">{(page - 1) * pageSize + index + 1}</td>{columns.map(column => <td key={column}><button className={`cell-value ${column === "_id" ? "id-value" : ""} ${row.value[column] == null ? "null-value" : ""}`} title={display(row.value[column])} onClick={() => { setSelected(row); setMutationError(""); }}>{display(row.value[column])}</button></td>)}<td><div className="row-actions"><button className="icon-button" aria-label={`View ${postgres ? "row" : "document"} ${index + 1}`} title={postgres ? "View or edit row" : "View or edit document"} onClick={() => { setSelected(row); setMutationError(""); }}><Braces size={16} /></button><button className="icon-button delete-icon" aria-label={`Delete ${postgres ? "row" : "document"} ${index + 1}`} title={postgres ? "Delete row" : "Delete document"} disabled={readOnly} onClick={() => { setDeleting(row); setMutationError(""); }}><Trash2 size={15} /></button></div></td></tr>)}</tbody></table></div> : <div className="json-list">{results.documents.map((row, index) => <article className="json-card" key={`${row.revision}-${index}`}><div className="json-card-heading"><span>{postgres ? "ROW" : "DOCUMENT"} {((page - 1) * pageSize + index + 1).toString().padStart(2, "0")}</span><div className="button-group"><button className="button small secondary" onClick={() => { setSelected(row); setMutationError(""); }}><Braces size={14} />{postgres ? "Open row" : "Open document"}</button><button className="icon-button delete-icon" aria-label={`Delete ${postgres ? "row" : "document"} ${index + 1}`} disabled={readOnly} onClick={() => { setDeleting(row); setMutationError(""); }}><Trash2 size={15} /></button></div></div><Highlight value={row.value} /></article>)}</div>}
          <div className="pagination"><span>{results?.documents.length ? `${((page - 1) * pageSize + 1).toLocaleString()}–${((page - 1) * pageSize + results.documents.length).toLocaleString()}${results.total !== null ? ` of ${results.total.toLocaleString()}` : ""} ${postgres ? "rows" : "documents"}` : postgres ? "0 rows" : "0 documents"}</span><div className="pagination-controls"><label>Rows per page<select aria-label="Rows per page" value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}>{[10, 25, 50, 100].map(size => <option key={size}>{size}</option>)}</select></label><button className="icon-button bordered" aria-label="Previous page" disabled={busy || page === 1} onClick={() => setPage(value => value - 1)}><ArrowLeft size={15} /></button><span>Page {page}</span><button className="icon-button bordered" aria-label="Next page" disabled={busy || !results?.hasNext} onClick={nextPage}><ArrowRight size={15} /></button></div></div>
          </section><div className="data-footer"><ShieldCheck size={14} /><span>Changes apply directly to your database. Deletions always require confirmation.</span><span className="sort-note">{postgres ? (results?.pagination === "preview" ? "Unsorted preview" : "Sorted by primary key") : "Sorted by _id, descending"}</span></div>
        </>}
      </>}
      <footer className="workspace-footer"><span>DATABASE BROWSER</span><span>A simple window into your database.</span><span>Built for focus.</span></footer>
    </main>
    {showConnection && <Modal title="Change connection" onClose={() => setShowConnection(false)}><ConnectionForm profiles={profiles || []} connection={connection} onConnected={connected} onCancel={() => setShowConnection(false)} /></Modal>}
    {showDatabase && connection && <Modal title="Open a database" onClose={() => setShowDatabase(false)}><DatabasePicker postgres={postgres} key={connection.token} token={connection.token} onOpen={name => { chooseDatabase(name); setShowDatabase(false); }} onLoaded={names => setExtraDatabases(current => [...new Set([...current, ...names])])} /></Modal>}
    {selected && !deleting && <DocumentEditor postgres={postgres} row={selected} readOnly={readOnly} busy={mutationBusy} error={mutationError} onClose={closeEditor} onSave={text => mutate("update", selected, text)} onDelete={() => { setDeleting(selected); setMutationError(""); }} />}
    {deleting && <Modal title={postgres ? "Delete this row?" : "Delete this document?"} onClose={() => { if (!mutationBusy) { setDeleting(null); setMutationError(""); } }}><div className="delete-content"><span className="delete-illustration"><Trash2 size={24} /></span><p>This will permanently delete <strong>{postgres ? "one row" : "one document"}</strong> from <strong>{collectionLabel}</strong> in <strong>{database}</strong>.</p><div className="delete-id"><span>{postgres ? "Primary key" : "_id"}</span><code>{postgres ? json(deleting.id) : display(deleting.value._id)}</code></div><p className="muted">This action cannot be undone.</p>{mutationError && <div className="error" role="alert">{mutationError}</div>}<div className="form-actions"><button className="button secondary" disabled={mutationBusy} onClick={() => { setDeleting(null); setMutationError(""); }}>Cancel</button><button className="button danger" disabled={mutationBusy} onClick={() => mutate("delete", deleting)}>{mutationBusy ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}Delete document</button></div></div></Modal>}
    {showHelp && <Modal title="A quick guide" onClose={() => setShowHelp(false)}><div className="guide">{postgres ? <><p><strong>1. Connect.</strong> Use a postgres:// or postgresql:// URI, or a configured environment profile.</p><p><strong>2. Explore.</strong> Tables and views show their schema and name. Pages load on demand without counting every row. Tables without a primary key show a limited preview. Use + to open another database.</p><p><strong>SQL editor.</strong> Open SQL editor to run a read-only SELECT or WITH query. Ctrl+Space suggests tables and columns; $1, $2, and other bind parameters get their own value inputs. Ctrl/⌘+Enter runs the query with a five-second timeout and a bounded result set. New query opens another tab, each with its own draft and results; one query runs at a time.</p><p><strong>3. Search.</strong> Select one column for text search. Indexed equality or range filters are preferable for large tables. JSON filters support equality, comparisons, $contains, and null; multiple conditions are combined with AND.</p><p><strong>4. Edit.</strong> Values are strings in PostgreSQL text format to preserve precision; use null for SQL NULL. Keep every column. Primary keys and generated columns cannot change.</p><p><strong>5. Delete.</strong> Deletion targets one primary key after confirmation. Views and tables without a primary key are read-only. Concurrent changes produce a conflict.</p></> : <><p><strong>1. Connect.</strong> Select DB or TENANT_DB from your environment, or enter a MongoDB URI. DocumentDB connections use global-bundle.pem automatically.</p><p><strong>2. Explore.</strong> Choose a database, then a collection. MongoDB organizes documents into collections; names containing dots are displayed as full collection names.</p><p><strong>3. Search.</strong> Text search checks string fields detected in the first 100 documents, including nested fields. Enter a field path for other fields. Use JSON filters for exact values, numbers, dates, and operators.</p><pre>{'{ "status": "active" }\n{ "age": { "$gte": 18 } }\n{ "user.email": { "$regex": "@example.com$" } }'}</pre><p><strong>4. Edit.</strong> Open any document and choose Edit document. Keep Extended JSON wrappers such as $oid, $date, and $numberLong to preserve types. Save replaces the full document, so removing a field removes it from the database.</p><p><strong>5. Delete.</strong> The trash button deletes a single document after confirmation. System collections and views are read-only.</p></>}<p className="muted">Connections expire after 30 minutes of inactivity. This app is intended to run locally on your machine.</p></div></Modal>}
    {toast && <div className="toast" role="status"><Check size={17} />{toast}<button className="icon-button small" aria-label="Dismiss notification" onClick={() => setToast("")}><X size={14} /></button></div>}
  </div>;
}

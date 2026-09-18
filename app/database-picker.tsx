"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Database, LoaderCircle } from "lucide-react";

export default function DatabasePicker({ token, postgres, onOpen, onLoaded }: { token: string; postgres: boolean; onOpen: (name: string) => void; onLoaded: (names: string[]) => void }) {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState<string[] | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function load() {
    const request = new AbortController(); controller.current = request;
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/mongo", { method: "POST", signal: request.signal,
        headers: { "Content-Type": "application/json", "X-Mongo-Browser": "1", "X-Connection-Token": token },
        body: JSON.stringify({ action: "databases" }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load database names.");
      if (!request.signal.aborted) { setLoaded(result.databases); onLoaded(result.databases); }
    } catch (error) { if (!request.signal.aborted) setError((error as Error).message); }
    finally { if (!request.signal.aborted) setLoading(false); }
  }

  return <form className="connection-form" onSubmit={event => { event.preventDefault(); if (name.trim()) onOpen(name.trim()); }}>
    <label htmlFor="manual-db">Database name</label>
    <input autoFocus id="manual-db" required list="available-databases" value={name} onChange={event => setName(event.target.value)} placeholder="Enter an existing database name" />
    <p className="field-help">Opening a database by name avoids listing every database on your cluster.</p>
    <button className="button primary" type="submit">Open database<ArrowRight size={16} /></button>
    <div className="panel-footer">Optional database discovery</div>
    <p className="field-help">{postgres ? "Load databases that your PostgreSQL account has permission to connect to." : "Load database names only if you need them. This runs a cluster-wide listDatabases command and may add load to large clusters."}</p>
    <button className="button secondary" type="button" disabled={loading || loaded !== null} onClick={load}>{loading ? <LoaderCircle className="spin" size={16} /> : <Database size={16} />}{loading ? "Loading database names…" : loaded ? `${loaded.length} database names loaded` : "Load all database names"}</button>
    {loaded && <><datalist id="available-databases">{loaded.map(item => <option key={item} value={item} />)}</datalist><label htmlFor="loaded-db">Choose a discovered database</label><select id="loaded-db" value={name} onChange={event => setName(event.target.value)}><option value="">Select database</option>{name && !loaded.includes(name) && <option value={name}>{name}</option>}{loaded.map(item => <option key={item}>{item}</option>)}</select></>}
    {error && <div className="error" role="alert">{error} You can still enter a database name above.</div>}
  </form>;
}

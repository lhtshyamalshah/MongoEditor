"use client";

import { useRef, useState } from "react";
import { Code2, LoaderCircle, Plus, X } from "lucide-react";
import type { SqlTable } from "@/lib/sql-editor";
import SqlConsole, { type SessionState } from "./sql-console";

type Session = SessionState & { id: number };

function title(session: Session) { return session.label || `Query ${session.id}`; }

export default function SqlWorkspace({ token, database, tables, selected, active }: { token: string; database: string; tables: SqlTable[]; selected: string; active: boolean }) {
  const [sessions, setSessions] = useState<Session[]>([{ id: 1, label: "", dirty: false, busy: false }]);
  const [current, setCurrent] = useState(1);
  const nextId = useRef(2);

  function open() {
    const id = nextId.current++;
    setSessions(list => [...list, { id, label: "", dirty: false, busy: false }]);
    setCurrent(id);
  }
  function close(session: Session) {
    if (session.dirty && !window.confirm(`Close ${title(session)} and discard its query?`)) return;
    const index = sessions.indexOf(session);
    const remaining = sessions.filter(item => item !== session);
    setSessions(list => list.filter(item => item.id !== session.id));
    if (current === session.id) setCurrent(remaining[Math.min(index, remaining.length - 1)].id);
  }

  return <section className="documents-panel sql-workspace" aria-label="PostgreSQL SQL console">
    <div className="documents-toolbar"><div className="documents-title"><Code2 size={18} /><h2>SQL editor</h2><span className="readonly-badge">Read only</span></div><span className="muted">{database}</span></div>
    <div className="sql-tabs" role="group" aria-label="Query sessions">
      {sessions.map(session => <div key={session.id} className={`sql-tab ${session.id === current ? "selected" : ""}`}>
        <button className="sql-tab-name" aria-pressed={session.id === current} title={title(session)} onClick={() => setCurrent(session.id)}>{session.busy ? <LoaderCircle size={12} className="spin" /> : <Code2 size={12} />}<span>{title(session)}</span></button>
        {sessions.length > 1 && <button className="icon-button small sql-tab-close" aria-label={`Close ${title(session)}`} onClick={() => close(session)}><X size={13} /></button>}
      </div>)}
      <button className="sql-tab-new" disabled={sessions.length >= 25} title={sessions.length >= 25 ? "Close a query tab to open another" : "Open another query tab"} onClick={open}><Plus size={14} />New query</button>
    </div>
    {sessions.map(session => <div key={session.id} hidden={session.id !== current}>
      <SqlConsole token={token} database={database} tables={tables} selected={selected} active={active && session.id === current}
        blocked={sessions.some(other => other.id !== session.id && other.busy)}
        onState={state => setSessions(list => list.map(item => item.id === session.id ? { ...item, ...state } : item))} />
    </div>)}
  </section>;
}

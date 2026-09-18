"use client";

import { useState } from "react";
import { ChevronRight, FolderTree, Layers3, LockKeyhole, Users } from "lucide-react";

type TableInfo = { name: string; label?: string; schema?: string; table?: string; owner?: string; type: string; readOnly?: boolean };

export default function PostgresTableList({ items, selected, search, onSelect }: {
  items: TableInfo[]; selected: string; search: string; onSelect: (name: string) => void;
}) {
  const [groupBy, setGroupBy] = useState<"owner" | "schema">("owner");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  function toggle(key: string) {
    setCollapsed(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }
  // Older in-memory metadata may not contain the new fields until its TTL ends.
  const tables = items.map(item => {
    let pair: string[] = [];
    try { const parsed = JSON.parse(item.name); if (Array.isArray(parsed)) pair = parsed; } catch { /* Use the display label until metadata refreshes. */ }
    return { ...item, schema: item.schema || pair[0] || "Unknown schema", table: item.table || pair[1] || item.label || item.name, owner: item.owner || "Unknown owner" };
  });
  function groupTables(rows: typeof tables, key: "owner" | "schema") {
    const groups = new Map<string, typeof tables>();
    for (const item of rows) {
      const group = groups.get(item[key]);
      if (group) group.push(item); else groups.set(item[key], [item]);
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b));
  }
  function tableButtons(rows: typeof tables) {
    return rows.map(item => <button key={item.name} type="button" title={`${item.label || item.name}\nOwner: ${item.owner}`} className={`collection-item ${selected === item.name ? "active" : ""}`} onClick={() => onSelect(item.name)} aria-current={selected === item.name ? "true" : undefined}>
      <Layers3 size={14} /><span>{item.table}</span>{item.readOnly || item.type === "view" ? <LockKeyhole size={12} /> : selected === item.name && <ChevronRight size={13} />}
    </button>);
  }
  function group(key: string, label: string, count: number, nested: boolean, children: React.ReactNode) {
    // Search results stay expanded so a match cannot be hidden in a closed group.
    const open = !!search.trim() || !collapsed.has(key);
    return <section className={`table-group${nested ? " nested" : ""}`} key={key}>
      <button type="button" className="table-group-heading" aria-expanded={open} onClick={() => toggle(key)} disabled={!!search.trim()} title={label}>
        <ChevronRight size={13} className={open ? "expanded" : ""} />{!nested && groupBy === "owner" ? <Users size={14} /> : <FolderTree size={14} />}<span>{label}</span><small>{count}</small>
      </button>
      {open && <div className="table-group-content">{children}</div>}
    </section>;
  }
  return <>
    <label className="table-group-control">Group by<select aria-label="Group PostgreSQL tables by" value={groupBy} onChange={event => { setGroupBy(event.target.value as "owner" | "schema"); setCollapsed(new Set()); }}><option value="owner">Owner / user</option><option value="schema">Schema</option></select></label>
    {groupTables(tables, groupBy).map(([label, rows]) => group(JSON.stringify([groupBy, label]), label, rows.length, false,
      groupBy === "schema" ? tableButtons(rows) : groupTables(rows, "schema").map(([schema, schemaRows]) => group(JSON.stringify(["owner", label, schema]), schema, schemaRows.length, true, tableButtons(schemaRows)))
    ))}
  </>;
}

"use client";
/** Searchable verified-university directory (T16). Only verified institutions render. */
import { useMemo, useState } from "react";
import type { University } from "@/lib/types";

export function UniversitySearch({
  universities,
  loading,
  selectedId,
  onSelect,
}: {
  universities: University[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (u: University) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = universities.filter((u) => u.verified);
    if (!q) return list;
    return list.filter((u) => u.name.toLowerCase().includes(q) || u.country.toLowerCase().includes(q));
  }, [universities, query]);

  return (
    <div className="card">
      <h2>Find your university</h2>
      <label htmlFor="usearch">Search verified institutions</label>
      <input id="usearch" placeholder="Search by name or country…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {loading ? (
        <div className="muted" style={{ marginTop: 10 }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="muted" style={{ marginTop: 10 }}>No matches.</div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
          {filtered.map((u) => (
            <li key={u.id} style={{ marginBottom: 8 }}>
              <button
                className={selectedId === u.id ? "accent" : "secondary"}
                style={{ marginTop: 0, textAlign: "left" }}
                onClick={() => onSelect(u)}
                aria-pressed={selectedId === u.id}
              >
                {u.name} · {u.country} · bills in {u.currency}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

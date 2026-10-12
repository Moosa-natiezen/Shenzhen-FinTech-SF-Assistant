"use client";
/** Immutable tuition receipts. Visibility is scoped server-side by RLS: a student
 * sees their own, a SPONSOR sees only LINKED students' (sponsor_links), compliance
 * sees all (T17). This component just renders whatever the gateway returns. */
import { fmt } from "@/lib/money";
import type { ReceiptRow } from "@/lib/types";

export function ReceiptsList({ receipts, loading }: { receipts: ReceiptRow[]; loading: boolean }) {
  if (loading) return <div className="card">Loading receipts…</div>;
  return (
    <div className="card">
      <h2>Receipts</h2>
      {receipts.length === 0 ? (
        <div className="muted">No receipts visible to you.</div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {receipts.map((r) => (
            <li key={r.id} style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
              <div className="row">
                <span>{r.universityId}</span>
                <span className="amount">{fmt(r.amount)} {r.currency}</span>
              </div>
              <div className="muted">
                {r.status} · {new Date(r.createdAt).toLocaleDateString()} · hash {r.receiptHash.slice(0, 12)}…
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

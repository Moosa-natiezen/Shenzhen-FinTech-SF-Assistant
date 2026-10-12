"use client";
/**
 * Flagged / high-risk transaction review (T19 / Access Control Matrix:
 * Compliance & Admin "inspect flagged or high-risk transactions").
 * Rendered only in the compliance console; the API additionally enforces
 * compliance RBAC + MFA enrollment server-side.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { FlaggedTransfer } from "@/lib/types";

const FLAG_LABELS: Record<string, string> = {
  screening_block: "⛔ screening block",
  screening_reason: "⚠️ screening flag",
  large_transfer: "💸 large transfer",
};

export function FlaggedList() {
  const [rows, setRows] = useState<FlaggedTransfer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await api<{ flagged: FlaggedTransfer[] }>("/api/admin/flagged");
      setRows(r.flagged);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load flagged transactions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Flagged transactions</h2>
      <p className="muted">High-risk and blocked transfers. Compliance tier + MFA required.</p>
      {loading ? (
        <div className="muted">Loading…</div>
      ) : error ? (
        <div className="error">{error}</div>
      ) : rows.length === 0 ? (
        <div className="muted">No flagged transactions.</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map((r) => (
            <div key={r.id} className="transparency" style={{ marginTop: 0 }}>
              <div className="line">
                <span>
                  {r.kind} · {r.fromCurrency}
                  {r.toCurrency !== r.fromCurrency ? ` → ${r.toCurrency}` : ""}
                </span>
                <span className="amount">{r.amountFrom}</span>
              </div>
              <div className="line">
                <span className="muted" style={{ fontSize: 12 }}>
                  {new Date(r.occurredAt).toLocaleString()} · {r.status}
                  {r.screeningReason ? ` · ${r.screeningReason}` : ""}
                </span>
                <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {r.flags.map((f) => (
                    <span key={f} className="pill" style={{ fontSize: 11 }}>
                      {FLAG_LABELS[f] ?? f}
                    </span>
                  ))}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

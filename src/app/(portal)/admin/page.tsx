"use client";
/** Compliance admin (T13): generate a Metro-2 export (compliance + MFA tier).
 * The export never contains plaintext SPII — the enclave tokenizes it server-side. */
import { useState } from "react";
import { api } from "@/lib/api";
import { LockIcon } from "@/components/LockIcon";
import type { Metro2Export } from "@/lib/types";

export default function AdminPage() {
  const [studentUserId, setStudentUserId] = useState("");
  const [result, setResult] = useState<Metro2Export | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ export: Metro2Export }>("/api/admin/metro2/export", { body: { studentUserId } });
      setResult(r.export);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>
        Metro 2 export <span className="lock" style={{ color: "var(--accent)" }}><LockIcon size={13} /></span>
      </h2>
      <p className="muted">Compliance tier + MFA required. Exports contain a tokenized account reference — never plaintext SPII.</p>
      <form onSubmit={generate}>
        <label htmlFor="sid">Student user ID</label>
        <input id="sid" value={studentUserId} onChange={(e) => setStudentUserId(e.target.value)} required />
        {error && <div className="error">{error}</div>}
        <button type="submit" disabled={busy || !studentUserId}>
          {busy ? "Generating…" : "Generate export"}
        </button>
      </form>
      {result && (
        <div className="transparency" style={{ marginTop: 14 }}>
          <div className="line">
            <span>Records</span>
            <span className="amount">{result.records.length}</span>
          </div>
          {result.records.map((r) => (
            <div key={r.accountNumber} style={{ marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
              <div className="line">
                <span>Account (tokenized)</span>
                <span className="pill">{r.accountNumber}</span>
              </div>
              <div className="line">
                <span>Payment rating</span>
                <span className="amount">{r.paymentRating}</span>
              </div>
              <div className="line">
                <span>R_score</span>
                <span className="amount">{r.rscore}</span>
              </div>
            </div>
          ))}
          <div className="line total">
            <span>Checksum</span>
            <span className="pill">{result.checksum.slice(0, 16)}…</span>
          </div>
        </div>
      )}
    </div>
  );
}

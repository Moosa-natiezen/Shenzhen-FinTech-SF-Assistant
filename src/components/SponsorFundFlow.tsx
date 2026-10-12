"use client";
/**
 * Sponsor funding initiation (T17 / design doc "Fund Initiation"): a dedicated,
 * simplified dashboard where a sponsor deposits home-currency funds into the
 * platform. The sponsor's own funding source is learned via
 * /api/funding/source (funding:readSourceDetails) — not the general wallet:read,
 * which the sponsor tier is denied (I-1).
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { fmt } from "@/lib/money";
import { LockIcon } from "./LockIcon";
import type { FundingSource, FundingResult } from "@/lib/types";

export function SponsorFundFlow({ onFunded }: { onFunded: () => void }) {
  const [sources, setSources] = useState<FundingSource[]>([]);
  const [walletId, setWalletId] = useState("");
  const [amount, setAmount] = useState("");
  const [result, setResult] = useState<FundingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await api<{ wallets: FundingSource[] }>("/api/funding/source");
      setSources(r.wallets);
      if (r.wallets[0]) setWalletId((prev) => prev || r.wallets[0]!.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load funding source");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = sources.find((s) => s.id === walletId);

  async function deposit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ deposit: FundingResult }>("/api/funding/deposit", { body: { walletId, amount } });
      setResult(r.deposit);
      onFunded();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deposit failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>
        Initiate funding <span className="lock" style={{ color: "var(--accent)" }}><LockIcon size={13} /></span>
      </h2>
      {loading ? (
        <div className="muted">Loading funding source…</div>
      ) : sources.length === 0 ? (
        <div className="muted">No funding wallet yet — one is provisioned during onboarding.</div>
      ) : (
        <form onSubmit={deposit}>
          <label htmlFor="src">Funding wallet</label>
          <select id="src" value={walletId} onChange={(e) => setWalletId(e.target.value)}>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.currency} ({s.kind}) — balance {fmt(s.balance)}
              </option>
            ))}
          </select>
          <label htmlFor="famt">Amount to deposit {selected ? `(${selected.currency})` : ""}</label>
          <input id="famt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          {error && <div className="error">{error}</div>}
          {result && (
            <div className="success">
              ✅ Deposited {fmt(result.amount)}. New balance {fmt(result.walletBalance)} {selected?.currency}.
            </div>
          )}
          <button type="submit" disabled={busy || !amount}>
            {busy ? "Depositing…" : "Deposit funds"}
          </button>
        </form>
      )}
    </div>
  );
}

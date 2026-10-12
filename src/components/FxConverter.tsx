"use client";
/**
 * Conversion widget (T15) enforcing RADICAL TRANSPARENCY: the live FX spot
 * rate, the θ margin spread, and the flat fee are all shown BEFORE confirmation.
 * Rates are always server-priced — the client sends an amount and a rate-lock id,
 * never a rate (I-4). A 30-second rate-lock countdown gates execution; when it
 * expires the user must re-lock.
 */
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { estimateHostCredit } from "@/lib/money";
import { LockIcon } from "./LockIcon";
import type { RateLock, Conversion, Wallet } from "@/lib/types";

export function FxConverter({ home, host, onConverted }: { home?: Wallet; host?: Wallet; onConverted: () => void }) {
  const [amount, setAmount] = useState("100");
  const [fee, setFee] = useState("0");
  const [lock, setLock] = useState<RateLock | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [result, setResult] = useState<Conversion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Rate-lock countdown from the server-provided expiry.
  useEffect(() => {
    if (!lock) return;
    const tick = () => {
      const remaining = Math.max(0, Math.floor((new Date(lock.expiresAt).getTime() - Date.now()) / 1000));
      setSeconds(remaining);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [lock]);

  const canConvert = !!home && !!host && !!lock && seconds > 0 && !busy;
  const estimated = lock ? estimateHostCredit(amount, fee, lock.fxFinal) : null;

  async function getRate() {
    if (!home || !host) return;
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const r = await api<{ lock: RateLock }>("/api/fx/rate", {
        body: { baseCurrency: home.currency, quoteCurrency: host.currency, amountBase: amount, feeFlat: fee },
      });
      setLock(r.lock);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not fetch a rate");
    } finally {
      setBusy(false);
    }
  }

  async function convert() {
    if (!home || !host || !lock) return;
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ conversion: Conversion }>("/api/fx/convert", {
        body: { homeWalletId: home.id, hostWalletId: host.id, amountBase: amount, rateLockId: lock.id },
      });
      setResult(r.conversion);
      setLock(null);
      onConverted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Conversion failed");
    } finally {
      setBusy(false);
    }
  }

  if (!home || !host) return null;

  return (
    <div className="card">
      <h2>
        Convert {home.currency} → {host.currency} <span className="lock" style={{ color: "var(--accent)" }}><LockIcon size={13} /></span>
      </h2>
      <label htmlFor="amt">Amount ({home.currency})</label>
      <input id="amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <label htmlFor="fee">Flat fee ({home.currency})</label>
      <input id="fee" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />

      {lock && (
        <div className="transparency" aria-live="polite">
          <div className="line">
            <span>Live FX spot rate</span>
            <span className="amount">1 {home.currency} = {lock.fxSpot} {host.currency}</span>
          </div>
          <div className="line">
            <span>Margin spread (θ)</span>
            <span className="amount">{lock.margin}</span>
          </div>
          <div className="line">
            <span>Rate after margin</span>
            <span className="amount">1 {home.currency} = {lock.fxFinal} {host.currency}</span>
          </div>
          <div className="line">
            <span>Flat fee</span>
            <span className="amount">{lock.feeFlat} {home.currency}</span>
          </div>
          <div className="line total">
            <span>You receive (est.)</span>
            <span className="amount">{estimated} {host.currency}</span>
          </div>
          <div className="line" style={{ marginTop: 6 }}>
            <span>Rate locked for</span>
            <span className={`countdown ${seconds === 0 ? "expired" : ""}`}>
              {seconds > 0 ? `${seconds}s` : "expired"}
            </span>
          </div>
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {result && (
        <div className="success">
          Converted — received {result.hostCredited} {host.currency} at rate {result.fxFinal}.
        </div>
      )}

      {!lock ? (
        <button onClick={getRate} disabled={busy}>
          {busy ? "Getting rate…" : "Get live rate"}
        </button>
      ) : (
        <button className="accent" onClick={convert} disabled={!canConvert}>
          {seconds === 0 ? "Rate expired — re-lock" : busy ? "Converting…" : `Confirm conversion (${seconds}s)`}
        </button>
      )}
      {lock && seconds === 0 && (
        <button className="secondary" onClick={getRate} disabled={busy}>
          Re-lock rate
        </button>
      )}
    </div>
  );
}

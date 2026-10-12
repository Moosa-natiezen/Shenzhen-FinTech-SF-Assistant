"use client";
/**
 * Step-by-step tuition payment wizard (T16). The "Transaction Rails" component:
 * it clearly breaks down the fee versus the actual amount routed to the
 * institution BEFORE confirmation, protecting funds from hidden deductions.
 */
import { useState } from "react";
import { api } from "@/lib/api";
import { fmt } from "@/lib/money";
import { LockIcon } from "./LockIcon";
import type { Receipt, University, Wallet } from "@/lib/types";

const PLATFORM_FEE = "0"; // no hidden markup — tuition routes at cost

export function PaymentWizard({ university, wallet, onPaid }: { university: University; wallet?: Wallet; onPaid: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [amount, setAmount] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const total = (Number(amount) || 0) + Number(PLATFORM_FEE);

  async function confirm() {
    if (!wallet) return;
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ receipt: Receipt }>("/api/tuition/pay", {
        body: { universityId: university.id, walletId: wallet.id, amount },
      });
      setReceipt(r.receipt);
      setStep(3);
      onPaid();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>
        Pay tuition <span className="lock" style={{ color: "var(--accent)" }}><LockIcon size={13} /></span>
      </h2>
      <div className="muted">Paying {university.name} from your {university.currency} wallet.</div>

      {step === 1 && (
        <>
          <label htmlFor="tamt">Tuition amount ({university.currency})</label>
          <input id="tamt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <button onClick={() => amount && setStep(2)} disabled={!amount}>
            Review breakdown
          </button>
        </>
      )}

      {step === 2 && (
        <>
          <div className="transparency">
            <div className="line">
              <span>Amount routed to {university.name}</span>
              <span className="amount">{fmt(amount)} {university.currency}</span>
            </div>
            <div className="line">
              <span>Platform fee</span>
              <span className="amount">{fmt(PLATFORM_FEE)} {university.currency}</span>
            </div>
            <div className="line total">
              <span>Total deducted from wallet</span>
              <span className="amount">{fmt(String(total))} {university.currency}</span>
            </div>
          </div>
          {error && <div className="error">{error}</div>}
          <button className="accent" onClick={confirm} disabled={busy}>
            {busy ? "Processing…" : `Confirm payment of ${fmt(amount)} ${university.currency}`}
          </button>
          <button className="secondary" onClick={() => setStep(1)} disabled={busy}>
            Back
          </button>
        </>
      )}

      {step === 3 && receipt && (
        <div className="success">
          <div>✅ Payment settled — receipt sealed.</div>
          <div className="muted">Amount: {fmt(receipt.amount)} {receipt.currency}</div>
          <div className="muted">Receipt hash: <span className="pill">{receipt.receiptHash.slice(0, 16)}…</span></div>
          {typeof receipt.newScore === "number" && (
            <div className="muted">R_score now: {receipt.newScore} 📈</div>
          )}
          <button className="secondary" onClick={() => { setStep(1); setAmount(""); setReceipt(null); }}>
            Make another payment
          </button>
        </div>
      )}
    </div>
  );
}

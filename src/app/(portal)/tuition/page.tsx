"use client";
/** Tuition portal (T16): searchable directory + payment wizard + own receipts. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { UniversitySearch } from "@/components/UniversitySearch";
import { PaymentWizard } from "@/components/PaymentWizard";
import { fmt } from "@/lib/money";
import type { ReceiptRow, University, Wallet } from "@/lib/types";

export default function TuitionPage() {
  const [universities, setUniversities] = useState<University[]>([]);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [selected, setSelected] = useState<University | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [u, w, r] = await Promise.all([
        api<{ universities: University[] }>("/api/universities"),
        api<{ wallets: Wallet[] }>("/api/wallets"),
        api<{ receipts: ReceiptRow[] }>("/api/tuition/receipts"),
      ]);
      setUniversities(u.universities);
      setWallets(w.wallets);
      setReceipts(r.receipts);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Pay from whichever wallet is denominated in the institution's currency.
  const payWallet = useMemo(() => {
    if (!selected) return undefined;
    return wallets.find((w) => w.currency === selected.currency);
  }, [wallets, selected]);

  return (
    <>
      <UniversitySearch universities={universities} loading={loading} selectedId={selected?.id ?? null} onSelect={setSelected} />
      {selected && <PaymentWizard university={selected} wallet={payWallet} onPaid={() => void load()} />}

      <div className="card">
        <h2>Your receipts</h2>
        {receipts.length === 0 ? (
          <div className="muted">No payments yet.</div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {receipts.slice(0, 10).map((r) => (
              <li key={r.id} className="row" style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                <span>{r.universityId}</span>
                <span className="amount">{fmt(r.amount)} {r.currency}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

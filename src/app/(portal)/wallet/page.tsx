"use client";
/** Wallet (T15): dual-currency balance cards + the Radical-Transparency FX converter. */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { BalanceCards } from "@/components/BalanceCards";
import { FxConverter } from "@/components/FxConverter";
import type { Wallet } from "@/lib/types";

export default function WalletPage() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api<{ wallets: Wallet[] }>("/api/wallets");
      setWallets(r.wallets);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load wallets");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const home = wallets.find((w) => w.kind === "home");
  const host = wallets.find((w) => w.kind === "host");

  return (
    <>
      <BalanceCards wallets={wallets} loading={loading} />
      {error && <div className="error">{error}</div>}
      <FxConverter home={home} host={host} onConverted={() => void load()} />
    </>
  );
}

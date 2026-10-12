"use client";
/** Dual-currency balance cards (design doc): hold & switch home/host at a glance. */
import type { Wallet } from "@/lib/types";
import { fmt } from "@/lib/money";

export function BalanceCards({ wallets, loading }: { wallets: Wallet[]; loading: boolean }) {
  const home = wallets.find((w) => w.kind === "home");
  const host = wallets.find((w) => w.kind === "host");
  return (
    <div className="grid2">
      <div className="card">
        <h2>Home wallet</h2>
        {loading ? (
          <div className="muted">Loading…</div>
        ) : home ? (
          <>
            <div className="amount">{fmt(home.balance)}</div>
            <div className="muted">{home.currency}</div>
          </>
        ) : (
          <div className="muted">No home wallet</div>
        )}
      </div>
      <div className="card">
        <h2>Host wallet</h2>
        {loading ? (
          <div className="muted">Loading…</div>
        ) : host ? (
          <>
            <div className="amount">{fmt(host.balance)}</div>
            <div className="muted">{host.currency}</div>
          </>
        ) : (
          <div className="muted">No host wallet</div>
        )}
      </div>
    </div>
  );
}

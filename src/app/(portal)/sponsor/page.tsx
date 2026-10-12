"use client";
/** Sponsor dashboard (T17): funding initiation + receipts scoped to linked students. */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { SponsorFundFlow } from "@/components/SponsorFundFlow";
import { ReceiptsList } from "@/components/ReceiptsList";
import type { ReceiptRow } from "@/lib/types";

export default function SponsorPage() {
  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await api<{ receipts: ReceiptRow[] }>("/api/tuition/receipts");
      setReceipts(r.receipts);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <SponsorFundFlow onFunded={() => void load()} />
      <ReceiptsList receipts={receipts} loading={loading} />
    </>
  );
}

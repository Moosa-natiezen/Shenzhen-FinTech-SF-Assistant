"use client";
/** Receipts (T11/T17): RLS-scoped — student sees own, sponsor sees linked students. */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { ReceiptsList } from "@/components/ReceiptsList";
import type { ReceiptRow } from "@/lib/types";

export default function ReceiptsPage() {
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
  return <ReceiptsList receipts={receipts} loading={loading} />;
}

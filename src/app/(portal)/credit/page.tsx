"use client";
/** Credit Builder dashboard (T16): circular R_score gauge + education. */
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { CreditGauge } from "@/components/CreditGauge";
import type { Score } from "@/lib/types";

export default function CreditPage() {
  const [score, setScore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ score: Score | null }>("/api/credit/score")
      .then((r) => setScore(r.score?.score ?? null))
      .catch(() => setScore(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      {loading ? <div className="card">Loading…</div> : <CreditGauge score={score} />}
    </>
  );
}

"use client";
/** Landing: route by session role (server-assigned) to the appropriate home. */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

export default function Home() {
  const { me, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (loading) return;
    if (!me) {
      router.replace("/sign-in");
      return;
    }
    if (me.roles.includes("sponsor")) router.replace("/sponsor");
    else if (me.roles.includes("compliance_admin")) router.replace("/admin");
    else router.replace("/wallet");
  }, [me, loading, router]);
  return (
    <div className="shell">
      <div className="card">Loading…</div>
    </div>
  );
}

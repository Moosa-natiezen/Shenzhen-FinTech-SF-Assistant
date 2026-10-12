"use client";
/** Sign-in (T14): Better Auth email/password + TOTP step-up when MFA is on. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { LockIcon } from "@/components/LockIcon";
import type { Me } from "@/lib/types";

function roleHome(me: Me): string {
  if (me.roles.includes("sponsor")) return "/sponsor";
  if (me.roles.includes("compliance_admin")) return "/admin";
  return "/wallet";
}

export default function SignInPage() {
  const { signIn, refresh } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needs2FA, setNeeds2FA] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await signIn(email, password);
      if (r.needs2FA) {
        setNeeds2FA(true);
      } else {
        const me = await refresh();
        router.replace(me ? roleHome(me) : "/sign-in");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  async function submitTotp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/auth/two-factor/totp", { body: { code: totp } });
      const me = await refresh();
      router.replace(me ? roleHome(me) : "/sign-in");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell" style={{ paddingTop: 48 }}>
      <div className="brand" style={{ textAlign: "center", marginBottom: 16 }}>
        SZ FinTech SF <span className="lock"><LockIcon size={16} /></span>
      </div>
      <div className="card">
        <h2>{needs2FA ? "Two-factor authentication" : "Sign in"}</h2>
        {!needs2FA ? (
          <form onSubmit={submitPassword}>
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            {error && <div className="error">{error}</div>}
            <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          </form>
        ) : (
          <form onSubmit={submitTotp}>
            <p className="muted">Enter the 6-digit code from your authenticator app.</p>
            <label htmlFor="totp">Authentication code</label>
            <input id="totp" inputMode="numeric" value={totp} onChange={(e) => setTotp(e.target.value)} required />
            {error && <div className="error">{error}</div>}
            <button type="submit" disabled={busy}>{busy ? "Verifying…" : "Verify code"}</button>
          </form>
        )}
        <p className="muted" style={{ marginTop: 14 }}>
          No account? <Link href="/sign-up">Create one</Link>
        </p>
      </div>
    </div>
  );
}

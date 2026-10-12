"use client";
/** Sign-up (T14): role is SERVER-ASSIGNED (default student) — the form never sends a role (I-9). */
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { LockIcon } from "@/components/LockIcon";

export default function SignUpPage() {
  const { signUp, refresh } = useAuth();
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signUp(name, email, password);
      await refresh();
      router.replace("/wallet"); // fresh sign-ups are the student tier
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-up failed");
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
        <h2>Create your account</h2>
        <form onSubmit={submit}>
          <label htmlFor="name">Full name</label>
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          {error && <div className="error">{error}</div>}
          <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
        </form>
        <p className="muted" style={{ marginTop: 14 }}>
          Already registered? <Link href="/sign-in">Sign in</Link>
        </p>
      </div>
    </div>
  );
}

"use client";
/**
 * App shell (T14): brand + lock (Security & Trust), permission-tier badging,
 * high-contrast sponsor toggle, sign-out, and the role-aware bottom-tab nav.
 * Guards the portal: unauthenticated sessions bounce to /sign-in.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { useTheme } from "@/lib/theme-context";
import { PermissionBadge } from "@/components/PermissionBadge";
import { BottomTabNav } from "@/components/BottomTabNav";
import { LockIcon } from "@/components/LockIcon";

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const { me, loading, signOut } = useAuth();
  const { highContrast, toggleHighContrast } = useTheme();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !me) router.replace("/sign-in");
  }, [loading, me, router]);

  if (loading || !me) {
    return (
      <div className="shell">
        <div className="card">Loading…</div>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          SZ FinTech SF
          <span className="lock">
            <LockIcon size={14} />
          </span>
        </div>
        <div className="badges">
          <PermissionBadge />
          <button
            className="secondary"
            style={{ width: "auto", marginTop: 0, padding: "6px 10px", fontSize: 12 }}
            onClick={toggleHighContrast}
            aria-pressed={highContrast}
          >
            {highContrast ? "High contrast: ON" : "High contrast"}
          </button>
          <button
            className="secondary"
            style={{ width: "auto", marginTop: 0, padding: "6px 10px", fontSize: 12 }}
            onClick={async () => {
              await signOut();
              router.replace("/sign-in");
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main>{children}</main>
      <BottomTabNav />
    </div>
  );
}

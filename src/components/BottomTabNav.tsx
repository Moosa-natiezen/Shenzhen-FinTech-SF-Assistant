"use client";
/**
 * Single bottom-tab navigation (design doc: "all features are centralized into a
 * single bottom-tab navigation structure"). Tabs are ROLE-AWARE: only the tabs a
 * session's roles permit are rendered (I-1 defense-in-depth on the client — the
 * gateway still enforces each route server-side).
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import type { AppRole } from "@/lib/types";

interface Tab {
  href: string;
  label: string;
  icon: string;
  roles: AppRole[];
}

const TABS: Tab[] = [
  { href: "/wallet", label: "Wallet", icon: "💳", roles: ["student"] },
  { href: "/tuition", label: "Tuition", icon: "🎓", roles: ["student"] },
  { href: "/credit", label: "Credit", icon: "📈", roles: ["student"] },
  { href: "/sponsor", label: "Fund", icon: "💸", roles: ["sponsor"] },
  { href: "/receipts", label: "Receipts", icon: "🧾", roles: ["student", "sponsor", "compliance_admin"] },
  { href: "/admin", label: "Admin", icon: "🛡️", roles: ["compliance_admin"] },
];

export function BottomTabNav() {
  const { me } = useAuth();
  const pathname = usePathname();
  if (!me) return null;
  const visible = TABS.filter((t) => t.roles.some((r) => me.roles.includes(r)));
  if (visible.length === 0) return null;
  return (
    <nav className="bottom-tabs" aria-label="Primary">
      {visible.map((t) => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link key={t.href} href={t.href} className={`tab ${active ? "tab-active" : ""}`} aria-current={active ? "page" : undefined}>
            <span className="tab-icon" aria-hidden>
              {t.icon}
            </span>
            <span className="tab-label">{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

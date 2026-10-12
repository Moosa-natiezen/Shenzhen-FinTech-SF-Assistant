"use client";
/** Permission-tier badging (design doc + I-1): visual cue for the session's roles. */
import { useAuth } from "@/lib/auth-context";
import { LockIcon } from "./LockIcon";

const LABELS: Record<string, { label: string; cls: string }> = {
  student: { label: "Student", cls: "badge badge-student" },
  sponsor: { label: "Sponsor", cls: "badge badge-sponsor" },
  compliance_admin: { label: "Compliance", cls: "badge badge-compliance" },
};

export function PermissionBadge() {
  const { me } = useAuth();
  if (!me) return null;
  return (
    <div className="badges">
      <LockIcon size={13} title="Session secured" />
      {me.roles.map((r) => {
        const meta = LABELS[r] ?? { label: r, cls: "badge" };
        return (
          <span key={r} className={meta.cls}>
            {meta.label}
          </span>
        );
      })}
    </div>
  );
}

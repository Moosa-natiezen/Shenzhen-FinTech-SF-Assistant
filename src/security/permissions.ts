/**
 * Access Control Matrix — transcribed 1:1 from "Security Checks" §1
 * (Access Control Matrix) and Tech Spec §3.1 (Permission-Tier Implementation).
 *
 * Design principles enforced here:
 *  - Deny by default: every operation must be explicitly granted to a role.
 *  - Restricted operations (raw balance overrides, MFA bypass, plaintext PII
 *    export, third-party credit lines, schema access) exist as statements ONLY
 *    so tests can assert that NO role holds them. They are never granted.
 *  - Client requests can never grant roles/permissions: role is server-assigned
 *    at signup (default "student"); compliance admins are bootstrapped only via
 *    the server-side BOOTSTRAP_ADMIN_EMAILS allowlist.
 */
import { createAccessControl } from "better-auth/plugins/access";

export const permissionStatements = {
  // Student: view personal multi-currency wallet balances; manage own host-currency settings.
  // "overrideBalance" is the restricted operation (alter raw balances) — never granted.
  wallet: ["read", "alterHostSettings", "overrideBalance"],
  // Student: initiate dynamic foreign exchange conversions.
  fx: ["convert"],
  // Sponsor: deposit home-currency funds, initiate cross-border funding transfers,
  // read their own funding-source details. "readSourceDetails" is restricted for
  // students (access parent funding source details) — granted to sponsor only.
  funding: ["deposit", "transfer", "readSourceDetails"],
  // Student: route tuition payments to verified institutions and manage their own
  // verified destinations. Sponsor: view receipts only ("modify university
  // destination routing details" is restricted for sponsors — never granted).
  tuition: ["pay", "readReceipts", "manageDestinations"],
  // Student: view personal R_score. "initiateThirdParty" (credit lines under
  // third-party identities) is restricted for all roles — never granted.
  // Compliance: generate/export Metro 2 credit bureau packages.
  credit: ["readScore", "initiateThirdParty", "exportMetro2"],
  // Compliance & Admin: inspect flagged/high-risk transactions; audit FX and
  // ledger settlement logs.
  compliance: ["inspectFlagged", "auditLedger"],
  // Administrative API endpoints (restricted for students & sponsors).
  admin: ["access"],
  // Restricted for Compliance & Admin: export unencrypted raw PII/SPII — never granted.
  sensitiveData: ["exportPlaintext"],
  // Restricted for everyone: bypass Better Auth MFA — never granted to any role.
  auth: ["bypassMfa"],
  // Restricted for everyone: modify or inspect database schemas — never granted.
  dbSchema: ["read", "write"],
} as const;

export type PermissionResource = keyof typeof permissionStatements;
export type PermissionAction<R extends PermissionResource = PermissionResource> =
  (typeof permissionStatements)[R][number];

const studentPermissions = {
  wallet: ["read", "alterHostSettings"],
  fx: ["convert"],
  tuition: ["pay", "manageDestinations"],
  credit: ["readScore"],
} as const;

const sponsorPermissions = {
  funding: ["deposit", "transfer", "readSourceDetails"],
  tuition: ["readReceipts"],
} as const;

const complianceAdminPermissions = {
  compliance: ["inspectFlagged", "auditLedger"],
  credit: ["exportMetro2"],
  admin: ["access"],
} as const;

export const ac = createAccessControl(permissionStatements);

export const studentRole = ac.newRole(studentPermissions);
export const sponsorRole = ac.newRole(sponsorPermissions);
export const complianceAdminRole = ac.newRole(complianceAdminPermissions);

export const ROLES = {
  student: studentRole,
  sponsor: sponsorRole,
  compliance_admin: complianceAdminRole,
} as const;

export type AppRole = keyof typeof ROLES;

export const DEFAULT_ROLE: AppRole = "student";

/** Roles whose API endpoints require MFA enrollment (hardware-backed TOTP). */
export const ADMIN_ROLES: readonly AppRole[] = ["compliance_admin"];

/**
 * Static role -> permissions map used by the API-gateway guards. Same source of
 * truth as the Better Auth roles above (derived from the same objects), so the
 * gateway and the auth layer can never drift apart.
 */
export const ROLE_PERMISSIONS: Record<AppRole, Partial<Record<PermissionResource, readonly string[]>>> = {
  student: studentPermissions,
  sponsor: sponsorPermissions,
  compliance_admin: complianceAdminPermissions,
};

export const ALL_APP_ROLES: readonly AppRole[] = ["student", "sponsor", "compliance_admin"];

export function isAppRole(value: string): value is AppRole {
  return (ALL_APP_ROLES as readonly string[]).includes(value);
}

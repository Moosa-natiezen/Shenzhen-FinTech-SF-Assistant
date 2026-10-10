/**
 * API-gateway authorization guards (design doc: "RBAC enforced at the API
 * Gateway level" + "scoped authorization middleware").
 *
 * All checks are default-deny: a missing/unknown role grants nothing, and a
 * permission absent from ROLE_PERMISSIONS is denied even if a client asks for
 * it explicitly (this is what makes the Restricted Operations column of the
 * Access Control Matrix enforceable, not merely documented).
 */
import {
  ADMIN_ROLES,
  ROLE_PERMISSIONS,
  isAppRole,
  type AppRole,
  type PermissionAction,
  type PermissionResource,
} from "./permissions";

export class ApiError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** Better Auth stores multi-role users as a comma-separated string. */
export function parseRoles(roleField: string | null | undefined): AppRole[] {
  if (!roleField) return [];
  const roles = roleField
    .split(",")
    .map((r) => r.trim())
    .filter(isAppRole);
  // de-duplicate, preserve order
  return [...new Set(roles)];
}

/** Default-deny permission check across all of a user's roles (union). */
export function can(
  roles: readonly AppRole[],
  resource: PermissionResource,
  action: PermissionAction,
): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role][resource]?.includes(action) ?? false);
}

/** Throws 403 unless at least one role holds the permission. */
export function requirePermission(
  roles: readonly AppRole[],
  resource: PermissionResource,
  action: PermissionAction,
): void {
  if (!can(roles, resource, action)) {
    throw new ApiError(403, `Forbidden: requires ${resource}:${action}`);
  }
}

export function isAdminTier(roles: readonly AppRole[]): boolean {
  return roles.some((r) => ADMIN_ROLES.includes(r));
}

/**
 * Compliance/admin endpoints are protected by MFA (design doc §1: "Admin API
 * endpoints protected by hardware MFA"; §2 Risk 4: mandatory MFA, no bypass).
 * A compliance_admin session is refused unless the account has completed MFA
 * enrollment — there is no bypassMfa permission for anyone, including admins.
 */
export function requireMfaEnrolled(user: { twoFactorEnabled?: boolean | null }): void {
  if (user.twoFactorEnabled !== true) {
    throw new ApiError(403, "Forbidden: MFA enrollment required for this permission tier");
  }
}

/**
 * Step-up window for sensitive operations (design doc Risk 4: "adaptive
 * step-up authentication when adding new payout targets or initiating large
 * transfers"). The session must have been established within `windowSeconds`.
 */
export function requireFreshAuth(
  session: { createdAt: Date | string },
  windowSeconds: number,
  now: Date = new Date(),
): void {
  const createdAt = new Date(session.createdAt).getTime();
  if (!Number.isFinite(createdAt)) {
    throw new ApiError(401, "Unauthorized: invalid session timestamp");
  }
  if ((now.getTime() - createdAt) / 1000 > windowSeconds) {
    throw new ApiError(401, "Unauthorized: step-up authentication required");
  }
}

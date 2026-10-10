/**
 * Session verification for the API gateway. Every protected route resolves the
 * Better Auth session from the request's secure HTTP-only cookie first; roles
 * come from the server-side session record, never from the request payload.
 */
import type { Auth } from "../auth";
import { ApiError, parseRoles } from "./guards";
import type { AppRole } from "./permissions";

type AuthInstance = Auth;

export type AuthedSession = NonNullable<Awaited<ReturnType<AuthInstance["api"]["getSession"]>>>;

export interface AuthedContext {
  session: AuthedSession;
  roles: AppRole[];
}

export async function getSessionOrThrow(
  authInstance: AuthInstance,
  headers: Headers,
): Promise<AuthedContext> {
  const result = await authInstance.api.getSession({ headers });
  if (!result) {
    throw new ApiError(401, "Unauthorized: no valid session");
  }
  if (result.user.banned) {
    throw new ApiError(403, "Forbidden: account suspended");
  }
  if (result.session.impersonatedBy) {
    // Impersonation must never be a path to privileged data in a financial system.
    throw new ApiError(403, "Forbidden: impersonated sessions cannot access this API");
  }
  return { session: result, roles: parseRoles(result.user.role) };
}

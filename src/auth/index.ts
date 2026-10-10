/**
 * Better Auth identity core (design doc §1.2):
 *  - Sessions via secure HTTP-only cookies, server-side validation in Neon.
 *  - MFA via the two-factor plugin (TOTP + backup codes); admin-tier endpoints
 *    additionally require enrollment (see guards.requireMfaEnrolled) and there
 *    is no MFA bypass for any role.
 *  - RBAC via the admin plugin bound to our Access Control Matrix roles.
 *  - Role is server-assigned; client-supplied roles are rejected (mass-
 *    assignment defense). Compliance admins are bootstrapped only through the
 *    server-side BOOTSTRAP_ADMIN_EMAILS allowlist.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins/admin";
import { twoFactor } from "better-auth/plugins/two-factor";
import type { AnyPgDatabase } from "../db/types";
import { loadEnv } from "../config/env";
import * as schema from "../db/schema";
import { DEFAULT_ROLE, ROLES, ac } from "../security/permissions";

export function createAuth(db: AnyPgDatabase) {
  const env = loadEnv();
  const bootstrapAdminEmails = new Set(
    (process.env.BOOTSTRAP_ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );

  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12, // stronger than the library default of 8
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // rolling refresh daily
      cookieCache: { enabled: false }, // always resolve the session server-side
    },
    user: {
      // Email/password for launch; social providers and passkeys are Phase-5.
      additionalFields: {},
    },
    databaseHooks: {
      user: {
        create: {
          // Defense-in-depth: the role column is NEVER taken from client input.
          // Default tier is "student"; compliance admins come only from the
          // server-side allowlist (set once at provisioning, then removed).
          before: async (u) => {
            const email = String(u.email ?? "").toLowerCase();
            // Never trust a client-supplied role: overwrite unconditionally.
            return { data: { ...u, role: bootstrapAdminEmails.has(email) ? "compliance_admin" : DEFAULT_ROLE } };
          },
        },
      },
    },
    plugins: [
      admin({
        defaultRole: DEFAULT_ROLE,
        adminRoles: ["compliance_admin"],
        ac,
        roles: ROLES,
      }),
      twoFactor(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

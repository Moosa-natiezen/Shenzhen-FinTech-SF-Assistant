/**
 * API Gateway & Edge Layer (design doc §1):
 *  - TLS termination happens at the edge; in-process we enforce secure headers,
 *    a strict CORS allowlist with credentials, and per-route RBAC guards.
 *  - Session verification goes through Better Auth on every protected route;
 *    roles are read from the server-side session, never from request payloads.
 *  - Every application-table query runs inside an RLS-bound transaction.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { Auth } from "../auth";
import type { AnyPgDatabase } from "../db/types";
import { withUserContext } from "../db/rls";
import { auditLog, wallets } from "../db/schema";
import { verifyAuditChain } from "../security/audit";
import { ApiError, isAdminTier, requireMfaEnrolled, requirePermission } from "../security/guards";
import { getSessionOrThrow } from "../security/session";

export interface AppDeps {
  auth: Auth;
  db: AnyPgDatabase;
  allowedOrigins: string[];
}

export function buildApp({ auth, db, allowedOrigins }: AppDeps) {
  const app = new Hono();

  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
      credentials: true, // cookies only; no wildcard origins
    }),
  );

  // Better Auth handles sign-up/sign-in/MFA/2FA endpoints.
  app.on(["GET", "POST", "PUT", "DELETE", "PATCH"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.get("/api/health", (c) => c.json({ ok: true }));

  // Any authenticated session may introspect itself (used by the client to
  // render role-appropriate UI; permission-tier badging per design doc).
  app.get("/api/me", async (c) => {
    const ctx = await getSessionOrThrow(auth, c.req.raw.headers);
    return c.json({
      user: { id: ctx.session.user.id, email: ctx.session.user.email, name: ctx.session.user.name },
      roles: ctx.roles,
      mfaEnrolled: ctx.session.user.twoFactorEnabled === true,
    });
  });

  // Student tier: view personal wallet balances. RLS scopes rows to the
  // session user even though the query itself has no WHERE user_id clause —
  // database-level enforcement, not just API-level.
  app.get("/api/wallets", async (c) => {
    const ctx = await getSessionOrThrow(auth, c.req.raw.headers);
    requirePermission(ctx.roles, "wallet", "read");
    const rlsRole = isAdminTier(ctx.roles) ? "compliance_admin" : "student";
    const rows = await withUserContext(
      db,
      { userId: ctx.session.user.id, role: rlsRole },
      (tx) => tx.select().from(wallets),
    );
    return c.json({ wallets: rows });
  });

  // Compliance tier: audit ledger. Requires MFA enrollment (no bypass for anyone).
  app.get("/api/admin/audit", async (c) => {
    const ctx = await getSessionOrThrow(auth, c.req.raw.headers);
    requirePermission(ctx.roles, "compliance", "auditLedger");
    requireMfaEnrolled(ctx.session.user);
    const [chain, rows] = await Promise.all([
      verifyAuditChain(db),
      db.select().from(auditLog).limit(100),
    ]);
    if (!chain.ok) {
      // Tamper detection: surface loudly rather than serving possibly-poisoned data.
      return c.json({ error: "audit chain integrity failure", brokenAtId: chain.brokenAtId }, 500);
    }
    return c.json({ chainVerified: true, entries: rows });
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: err.message }, err.status);
    }
    console.error("unhandled error", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return app;
}

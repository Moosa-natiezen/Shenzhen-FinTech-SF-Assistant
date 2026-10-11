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
import { ApiError, isAdminTier, requireFreshAuth, requireMfaEnrolled, requirePermission } from "../security/guards";
import { getSessionOrThrow } from "../security/session";
import { LedgerError } from "../ledger/engine";
import { lockRate } from "../fx/service";
import { convertFunds } from "../ledger/conversion";
import { depositFunds, transferFunds, isFirstTransferToRecipient } from "../transfers/service";
import { listUniversities, payTuition, listReceipts, TuitionError } from "../tuition/service";
import { getLatestScore } from "../credit/rscore";
import { generateMetro2Export } from "../reporting/metro2";
import { loadKeyringFromEnv } from "../security/spii";
import { can } from "../security/guards";

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


  // ---------------------------------------------------------------------------
  // Phase-2: Multi-currency wallet & ledger engine (T7-T10).
  // Money amounts are exact decimal STRINGS end-to-end (invariant I-10) — the
  // gateway rejects numbers so a float can never reach the ledger. Rates are
  // always server-computed; the convert endpoint takes a rate LOCK id, never a
  // rate value (invariant I-4).
  // ---------------------------------------------------------------------------

  const DECIMAL = /^\d+(\.\d{1,8})?$/;
  /** Validates a positive decimal-string money field (throws 400 otherwise). */
  function amount(value: unknown, field: string): string {
    if (typeof value !== "string" || !DECIMAL.test(value) || parseFloat(value) <= 0) {
      throw new ApiError(400, `Invalid ${field}: expected a positive decimal string`);
    }
    return value;
  }
  /** Validates an optional non-negative decimal-string money field. */
  function optionalAmount(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || !DECIMAL.test(value)) {
      throw new ApiError(400, `Invalid ${field}: expected a non-negative decimal string`);
    }
    return value;
  }
  function required(value: unknown, field: string): string {
    if (typeof value !== "string" || !value) throw new ApiError(400, `Missing ${field}`);
    return value;
  }

  // Step-up policy for sensitive money movement (design doc Risk 4).
  const STEP_UP_WINDOW_SECONDS = 300;
  const LARGE_TRANSFER_THRESHOLD = "1000";

  // T8: server-priced FX quote (rate lock). Requires fx:convert (student tier).
  app.post("/api/fx/rate", async (c) => {
    const ctx = await getSessionOrThrow(auth, c.req.raw.headers);
    requirePermission(ctx.roles, "fx", "convert");
    const body = await c.req.json();
    const lock = await lockRate(db, {
      userId: ctx.session.user.id,
      baseCurrency: required(body.baseCurrency, "baseCurrency"),
      quoteCurrency: required(body.quoteCurrency, "quoteCurrency"),
      amountBase: amount(body.amountBase, "amountBase"),
      feeFlat: optionalAmount(body.feeFlat, "feeFlat"),
    });
    return c.json({ lock });
  });

  // T9: execute a conversion against a live server-side lock.
  app.post("/api/fx/convert", async (c) => {
    const ctx = await getSessionOrThrow(auth, c.req.raw.headers);
    requirePermission(ctx.roles, "fx", "convert");
    const body = await c.req.json();
    const result = await convertFunds(db, {
      userId: ctx.session.user.id,
      homeWalletId: required(body.homeWalletId, "homeWalletId"),
      hostWalletId: required(body.hostWalletId, "hostWalletId"),
      amountBase: amount(body.amountBase, "amountBase"),
      rateLockId: required(body.rateLockId, "rateLockId"),
      feeFlat: optionalAmount(body.feeFlat, "feeFlat"),
    });
    return c.json({ conversion: result });
  });

  // T10: sponsor deposit (funding:deposit).
  app.post("/api/funding/deposit", async (c) => {
    const ctx = await getSessionOrThrow(auth, c.req.raw.headers);
    requirePermission(ctx.roles, "funding", "deposit");
    const body = await c.req.json();
    const result = await depositFunds(db, {
      sponsorUserId: ctx.session.user.id,
      walletId: required(body.walletId, "walletId"),
      amount: amount(body.amount, "amount"),
    });
    return c.json({ deposit: result });
  });

  // T10: sponsor -> recipient transfer (funding:transfer) with step-up for
  // new payout targets and large transfers.
  app.post("/api/funding/transfer", async (c) => {
    const ctx = await getSessionOrThrow(auth, c.req.raw.headers);
    requirePermission(ctx.roles, "funding", "transfer");
    const body = await c.req.json();
    const recipientUserId = required(body.recipientUserId, "recipientUserId");
    const amountFrom = amount(body.amountFrom, "amountFrom");

    const isNewTarget = await isFirstTransferToRecipient(db, ctx.session.user.id, recipientUserId);
    const isLarge = parseFloat(amountFrom) >= parseFloat(LARGE_TRANSFER_THRESHOLD);
    if (isNewTarget || isLarge) {
      requireFreshAuth(ctx.session.session, STEP_UP_WINDOW_SECONDS);
    }

    const result = await transferFunds(db, {
      senderUserId: ctx.session.user.id,
      recipientUserId,
      fromWalletId: required(body.fromWalletId, "fromWalletId"),
      toWalletId: required(body.toWalletId, "toWalletId"),
      amountFrom,
      rateLockId: body.rateLockId ? required(body.rateLockId, "rateLockId") : undefined,
      feeFlat: optionalAmount(body.feeFlat, "feeFlat"),
    });
    return c.json({ transfer: result });
  });


  // ---------------------------------------------------------------------------
  // Phase-3: Tuition routing & credit engine (T11-T13).
  // ---------------------------------------------------------------------------

  // T11: verified-institution directory (student tier).
  app.get("/api/universities", async (c) => {
    const ctx = await getSessionOrThrow(auth, c.req.raw.headers);
    requirePermission(ctx.roles, "tuition", "pay");
    const unis = await listUniversities(db);
    return c.json({ universities: unis });
  });

  // T11: student initiates a tuition payment to a verified institution.
  app.post("/api/tuition/pay", async (c) => {
    const ctx = await getSessionOrThrow(auth, c.req.raw.headers);
    requirePermission(ctx.roles, "tuition", "pay");
    const body = await c.req.json();
    const receipt = await payTuition(db, {
      studentUserId: ctx.session.user.id,
      universityId: required(body.universityId, "universityId"),
      walletId: required(body.walletId, "walletId"),
      amount: amount(body.amount, "amount"),
    });
    return c.json({ receipt });
  });

  // T11: receipts — student sees own, sponsor sees linked students (read-only,
  // RLS-scoped), compliance sees all.
  app.get("/api/tuition/receipts", async (c) => {
    const ctx = await getSessionOrThrow(auth, c.req.raw.headers);
    const isSponsor = can(ctx.roles, "tuition", "readReceipts");
    const isStudent = can(ctx.roles, "tuition", "pay");
    if (!isSponsor && !isStudent && !isAdminTier(ctx.roles)) {
      throw new ApiError(403, "Forbidden: requires tuition:pay or tuition:readReceipts");
    }
    const viewerRole = isAdminTier(ctx.roles) ? "compliance_admin" : isSponsor ? "sponsor" : "student";
    const rows = await listReceipts(db, { userId: ctx.session.user.id, role: viewerRole });
    return c.json({ receipts: rows });
  });

  // T12: student views their own R_score (RLS-scoped to owner).
  app.get("/api/credit/score", async (c) => {
    const ctx = await getSessionOrThrow(auth, c.req.raw.headers);
    requirePermission(ctx.roles, "credit", "readScore");
    const score = await getLatestScore(db, ctx.session.user.id);
    return c.json({ score });
  });

  // T13: Metro-2 export — compliance tier + MFA enrollment required (no bypass).
  app.post("/api/admin/metro2/export", async (c) => {
    const ctx = await getSessionOrThrow(auth, c.req.raw.headers);
    requirePermission(ctx.roles, "credit", "exportMetro2");
    requireMfaEnrolled(ctx.session.user);
    const body = await c.req.json();
    const ring = loadKeyringFromEnv(); // KMS-injected keys; decrypted only in the enclave
    const exportResult = await generateMetro2Export(db, ring, {
      studentUserId: required(body.studentUserId, "studentUserId"),
      actorUserId: ctx.session.user.id,
    });
    return c.json({ export: exportResult });
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: err.message }, err.status);
    }
    if (err instanceof LedgerError) {
      // Ledger/business-rule rejections (insufficient funds, caps, screening,
      // bad lock, unbalanced) are client-correctable: surface as 400 with code.
      return c.json({ error: err.message, code: err.code }, 400);
    }
    if (err instanceof TuitionError) {
      // Tuition routing rejections (unverified institution, bad wallet, etc.).
      return c.json({ error: err.message, code: err.code }, 400);
    }
    console.error("unhandled error", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return app;
}

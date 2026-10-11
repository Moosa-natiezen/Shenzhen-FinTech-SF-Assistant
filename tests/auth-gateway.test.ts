/**
 * End-to-end verification of the gateway as the CLIENT sees it (HTTP over the
 * Hono app + Better Auth handler), against a real Postgres engine (PGlite):
 *  - server-assigned default role (I-9), bootstrap admin allowlist
 *  - session cookie auth on protected routes (401 without)
 *  - cross-user wallet isolation through the API (I-1)
 *  - sponsor denied wallet reads (Access Control Matrix)
 *  - compliance tier: MFA-enrollment required, no bypass (I-7)
 *  - 2FA challenge prevents password-only sign-in
 *  - CORS allowlist with credentials
 */
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://u:p@localhost/test?sslmode=require";
process.env.BETTER_AUTH_SECRET = "test-secret-".repeat(5);
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.ALLOWED_ORIGINS = "http://localhost:3000";
process.env.BOOTSTRAP_ADMIN_EMAILS = "boss@example.com";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import { buildApp } from "../src/server/app";
import { withUserContext } from "../src/db/rls";
import { user, wallets } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { resetEnvCache } from "../src/config/env";
import { asAppRole } from "../src/db/pglite-dev-role";

resetEnvCache();

const schema = await import("../src/db/schema");
type Db = ReturnType<typeof drizzle<typeof schema>>;

let db: Db;
let app: ReturnType<typeof buildApp>;

function collectCookies(res: Response): string {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

async function signUp(email: string, name = "Test User") {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ name, email, password: "Sup3rSecret!pass" }),
  });
  return { res, cookies: collectCookies(res) };
}

async function signIn(email: string) {
  const res = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ email, password: "Sup3rSecret!pass" }),
  });
  return { res, cookies: collectCookies(res), body: (await res.clone().json()) as Record<string, unknown> };
}

beforeAll(async () => {
  const pg = new PGlite();
  db = drizzle(pg);
  await migrate(db, { migrationsFolder: "./drizzle" });
  // Non-superuser role: RLS must actually bind the app connection (see helper).
  await asAppRole(db);
  const auth = createAuth(db);
  app = buildApp({
    auth,
    db,
    allowedOrigins: ["http://localhost:3000"],
  });
});

describe("signup & role assignment (I-9)", () => {
  it("assigns the student tier by default, ignoring client input", async () => {
    const { res } = await signUp("alice@students.example.com", "Alice");
    expect(res.status).toBe(200);
    const row = await db.select().from(user).where(eq(user.email, "alice@students.example.com"));
    expect(row[0]?.role).toBe("student");
  });

  it("bootstrap allowlist provisions a compliance admin server-side", async () => {
    const { res } = await signUp("boss@example.com", "Boss");
    expect(res.status).toBe(200);
    const row = await db.select().from(user).where(eq(user.email, "boss@example.com"));
    expect(row[0]?.role).toBe("compliance_admin");
  });
});

describe("session enforcement on protected routes", () => {
  it("rejects /api/me without a session cookie (401)", async () => {
    const res = await app.request("/api/me", { headers: { origin: "http://localhost:3000" } });
    expect(res.status).toBe(401);
  });

  it("returns identity and roles with a valid session", async () => {
    const { cookies } = await signIn("alice@students.example.com");
    const res = await app.request("/api/me", { headers: { cookie: cookies, origin: "http://localhost:3000" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: string[]; mfaEnrolled: boolean };
    expect(body.roles).toEqual(["student"]);
    expect(body.mfaEnrolled).toBe(false);
  });
});

describe("wallet isolation through the API (I-1)", () => {
  let aliceId = "";

  beforeAll(async () => {
    // Second student with her own wallet.
    await signUp("bob@students.example.com", "Bob");
    const [aliceRow] = await db.select().from(user).where(eq(user.email, "alice@students.example.com"));
    const [bobRow] = await db.select().from(user).where(eq(user.email, "bob@students.example.com"));
    aliceId = aliceRow!.id;
    const bobId = bobRow!.id;
    await withUserContext(db, { userId: aliceId, role: "student" }, (tx) =>
      tx.insert(wallets).values([
        { id: "w-alice-cny", userId: aliceId, currency: "CNY", kind: "home", balance: "1000" },
        { id: "w-alice-gbp", userId: aliceId, currency: "GBP", kind: "host", balance: "100" },
      ]),
    );
    await withUserContext(db, { userId: bobId, role: "student" }, (tx) =>
      tx.insert(wallets).values([
        { id: "w-bob-cny", userId: bobId, currency: "CNY", kind: "home", balance: "5000" },
      ]),
    );
  });

  it("student sees only her own wallets, never another student's", async () => {
    const { cookies } = await signIn("alice@students.example.com");
    const res = await app.request("/api/wallets", { headers: { cookie: cookies, origin: "http://localhost:3000" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { wallets: Array<{ id: string; userId: string }> };
    expect(body.wallets.map((w) => w.id).sort()).toEqual(["w-alice-cny", "w-alice-gbp"]);
    expect(body.wallets.every((w) => w.userId === aliceId)).toBe(true);
  });
});

describe("Access Control Matrix via HTTP", () => {
  it("sponsor tier is denied wallet reads (403)", async () => {
    // Promote a user to sponsor server-side (linkage flow will do this later).
    await signUp("parent@family.example.com", "Parent");
    await db.update(user).set({ role: "sponsor" }).where(eq(user.email, "parent@family.example.com"));
    const { cookies } = await signIn("parent@family.example.com");
    const res = await app.request("/api/wallets", { headers: { cookie: cookies, origin: "http://localhost:3000" } });
    expect(res.status).toBe(403);
  });

  let bossCookies = "";

  it("compliance tier is denied the admin audit route without MFA enrollment (I-7)", async () => {
    const { cookies } = await signIn("boss@example.com");
    bossCookies = cookies;
    const res = await app.request("/api/admin/audit", { headers: { cookie: cookies, origin: "http://localhost:3000" } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/MFA/);
  });

  it("compliance tier passes after MFA enrollment; audit chain verified", async () => {
    // The pre-MFA session stays valid; the route guard re-reads the user and
    // now sees twoFactorEnabled=true. (A fresh password sign-in would be
    // challenged for 2FA — asserted in the next suite.)
    await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.email, "boss@example.com"));
    const res = await app.request("/api/admin/audit", { headers: { cookie: bossCookies, origin: "http://localhost:3000" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chainVerified: boolean };
    expect(body.chainVerified).toBe(true);
  });
});

describe("MFA cannot be bypassed by password alone (I-7)", () => {
  it("a 2FA-enrolled user gets a challenge, not a session", async () => {
    await signUp("mfa@students.example.com", "MFA User");
    await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.email, "mfa@students.example.com"));
    const { body, cookies } = await signIn("mfa@students.example.com");
    expect(body.twoFactorRedirect).toBe(true);
    // Whatever cookies came back must not constitute a valid session.
    const res = await app.request("/api/me", { headers: { cookie: cookies, origin: "http://localhost:3000" } });
    expect(res.status).toBe(401);
  });
});

describe("transport & origin hardening", () => {
  it("sets security headers", async () => {
    const res = await app.request("/api/health", { headers: { origin: "http://localhost:3000" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("does not grant CORS to foreign origins", async () => {
    const res = await app.request("/api/health", { headers: { origin: "https://evil.example.com" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("grants CORS with credentials to the allowlisted origin", async () => {
    const res = await app.request("/api/health", { headers: { origin: "http://localhost:3000" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
});

describe("Phase-2 money endpoints: RBAC + server-side FX (I-4)", () => {
  const json = (body: unknown) => ({
    method: "POST" as const,
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify(body),
  });

  it("student tier is denied sponsor deposits (403, requires funding:deposit)", async () => {
    const { cookies } = await signIn("alice@students.example.com");
    const res = await app.request("/api/funding/deposit", { ...json({ walletId: "w-alice-cny", amount: "10" }), headers: { ...json({}).headers, cookie: cookies } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/funding:deposit/);
  });

  it("sponsor tier is denied FX conversions (403, requires fx:convert)", async () => {
    const { cookies } = await signIn("parent@family.example.com");
    const res = await app.request("/api/fx/convert", { ...json({ homeWalletId: "x", hostWalletId: "y", amountBase: "1", rateLockId: "z" }), headers: { ...json({}).headers, cookie: cookies } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/fx:convert/);
  });

  it("fx/rate returns a server-priced lock and rejects malformed amounts (400)", async () => {
    const { cookies } = await signIn("alice@students.example.com");
    const ok = await app.request("/api/fx/rate", { ...json({ baseCurrency: "CNY", quoteCurrency: "GBP", amountBase: "100" }), headers: { ...json({}).headers, cookie: cookies } });
    expect(ok.status).toBe(200);
    const { lock } = (await ok.json()) as { lock: { fxFinal: string; fxSpot: string } };
    // Server computes 0.11 * 1.002 = 0.11022 — no client rate involved.
    expect(lock.fxSpot).toBe("0.11");
    expect(lock.fxFinal).toBe("0.11022000");

    // A number (float) amount is rejected outright (I-10 exactness).
    const bad = await app.request("/api/fx/rate", { ...json({ baseCurrency: "CNY", quoteCurrency: "GBP", amountBase: 100.5 }), headers: { ...json({}).headers, cookie: cookies } });
    expect(bad.status).toBe(400);
  });

  it("fx/convert ignores any client-supplied rate and uses the locked server rate", async () => {
    const { cookies } = await signIn("alice@students.example.com");
    const rateRes = await app.request("/api/fx/rate", { ...json({ baseCurrency: "CNY", quoteCurrency: "GBP", amountBase: "100", feeFlat: "0" }), headers: { ...json({}).headers, cookie: cookies } });
    const { lock } = (await rateRes.json()) as { lock: { id: string } };

    const before = await app.request("/api/wallets", { headers: { cookie: cookies, origin: "http://localhost:3000" } });
    const beforeBody = (await before.json()) as { wallets: Array<{ id: string; balance: string }> };
    const gbpBefore = beforeBody.wallets.find((w) => w.id === "w-alice-gbp")!.balance;

    // Send bogus client rates; the server must use the locked 0.11022.
    const res = await app.request("/api/fx/convert", {
      ...json({ homeWalletId: "w-alice-cny", hostWalletId: "w-alice-gbp", amountBase: "100", rateLockId: lock.id, fxFinal: "999", fxSpot: "999", rate: "999" }),
      headers: { ...json({}).headers, cookie: cookies },
    });
    expect(res.status).toBe(200);
    const { conversion } = (await res.json()) as { conversion: { hostCredited: string; fxFinal: string } };
    expect(conversion.fxFinal).toBe("0.11022000");
    expect(conversion.hostCredited).toBe("11.02200000"); // 100 * 0.11022, NOT 999
    expect(conversion.hostCredited).not.toBe("999");

    const after = await app.request("/api/wallets", { headers: { cookie: cookies, origin: "http://localhost:3000" } });
    const afterBody = (await after.json()) as { wallets: Array<{ id: string; balance: string }> };
    const gbpAfter = afterBody.wallets.find((w) => w.id === "w-alice-gbp")!.balance;
    expect(parseFloat(gbpAfter) - parseFloat(gbpBefore)).toBeCloseTo(11.022, 6);
  });
});

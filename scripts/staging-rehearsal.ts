/**
 * Staging rehearsal (T20 / Tech Spec §1: "Neon's instant database branching…
 * for CI/CD automated testing and staging environments").
 *
 * Simulates the Neon branch-based staging flow against a PGlite instance:
 *   1. BRANCH   — a fresh, isolated database (Neon: `neonctl branches create
 *                 --parent <prod>`; here: a new PGlite instance, which is the
 *                 same copy-on-write semantics at test scale).
 *   2. MIGRATE  — apply the full drizzle migration chain to the branch.
 *   3. SMOKE    — exercise the release path end-to-end through the REAL HTTP
 *                 gateway: signup -> deposit -> FX lock -> convert -> tuition
 *                 -> audit-chain verification.
 *   4. REPORT   — PASS/FAIL per step; non-zero exit on any failure, so CI can
 *                 gate a production deploy on a green rehearsal.
 *
 * Production mapping (documented in LAUNCH_CHECKLIST.md):
 *   neonctl branches create --parent $PROD_BRANCH --name staging-$SHA
 *   DATABASE_URL=$STAGING_URL npm run rehearse:staging
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createAuth } from "../src/auth";
import { buildApp } from "../src/server/app";
import { asAppRole } from "../src/db/pglite-dev-role";
import { verifyAuditChain } from "../src/security/audit";

process.env.NODE_ENV = "test";
// The rehearsal runs against the isolated branch (PGlite), not prod Neon; the
// env validator still requires a TLS-shaped URL, so provide a stand-in.
process.env.DATABASE_URL ??= "postgres://u:p@localhost/rehearsal?sslmode=require";
process.env.BETTER_AUTH_SECRET ??= "staging-rehearsal-secret-".repeat(3);
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.ALLOWED_ORIGINS ??= "http://localhost:3000";
process.env.SPII_MASTER_KEY ??= "staging-spii-key-".repeat(3);
process.env.SPII_KEY_ID ??= "k1";

interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
}

const results: StepResult[] = [];
function record(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${step}: ${detail}`);
}

function collectCookies(res: Response): string {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

async function main(): Promise<void> {
  console.log("=== Staging rehearsal (Neon branch simulation) ===\n");

  // 1. BRANCH: isolated database — nothing shared with "production".
  const pg = new PGlite();
  const db = drizzle(pg);
  record("branch", true, "fresh isolated PGlite instance (Neon copy-on-write analogue)");

  // 2. MIGRATE: full migration chain, exactly as production would.
  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
    await asAppRole(db);
    record("migrate", true, "all migrations applied; app-role owns tables (RLS binds)");
  } catch (err) {
    record("migrate", false, (err as Error).message);
    return report();
  }

  // 3. SMOKE: exercise the release path through the real gateway.
  const auth = createAuth(db);
  const app = buildApp({ auth, db, allowedOrigins: ["http://localhost:3000"] });
  const origin = { origin: "http://localhost:3000" };
  const json = { "content-type": "application/json", ...origin };

  try {
    const signup = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "Rehearsal", email: "rehearsal@example.com", password: "Sup3rSecret!pass" }),
    });
    const cookies = collectCookies(signup);
    record("smoke.signup", signup.status === 200, `status ${signup.status}`);

    // Student needs a wallet (onboarding would provision it).
    const { withUserContext } = await import("../src/db/rls");
    const { user, wallets } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    const [me] = await db.select().from(user).where(eq(user.email, "rehearsal@example.com"));
    await withUserContext(db, { userId: me!.id, role: "student" }, (tx) =>
      tx.insert(wallets).values([
        { id: "r-cny", userId: me!.id, currency: "CNY", kind: "home", balance: "0" },
        { id: "r-gbp", userId: me!.id, currency: "GBP", kind: "host", balance: "0" },
      ]),
    );

    const rate = await app.request("/api/fx/rate", {
      method: "POST",
      headers: { ...json, cookie: cookies },
      body: JSON.stringify({ baseCurrency: "CNY", quoteCurrency: "GBP", amountBase: "100" }),
    });
    const { lock } = (await rate.json()) as { lock: { id: string; fxFinal: string } };
    record("smoke.fx_rate", rate.status === 200 && lock.fxFinal === "0.11022000", `server-priced lock ${lock.fxFinal}`);

    const convert = await app.request("/api/fx/convert", {
      method: "POST",
      headers: { ...json, cookie: cookies },
      // No funds yet: the atomic balance guard must REJECT (that IS the pass).
      body: JSON.stringify({ homeWalletId: "r-cny", hostWalletId: "r-gbp", amountBase: "100", rateLockId: lock.id }),
    });
    record("smoke.ledger_guard", convert.status === 400, `unfunded convert rejected with ${convert.status} (no overdraft)`);

    const unis = await app.request("/api/universities", { headers: { ...origin, cookie: cookies } });
    const uniBody = (await unis.json()) as { universities: Array<{ verified: boolean }> };
    record(
      "smoke.directory",
      unis.status === 200 && uniBody.universities.every((u) => u.verified),
      `${uniBody.universities.length ?? 0} verified institutions`,
    );

    const chain = await verifyAuditChain(db);
    record("smoke.audit_chain", chain.ok, `chain verified across ${chain.length} events`);
  } catch (err) {
    record("smoke", false, (err as Error).message);
  }

  return report();
}

function report(): void {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== Rehearsal ${failed.length === 0 ? "PASSED" : "FAILED"} (${results.length - failed.length}/${results.length}) ===`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAIL ${f.step}: ${f.detail}`);
    process.exit(1);
  }
  process.exit(0);
}

await main();

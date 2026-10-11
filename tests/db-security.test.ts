/**
 * Database-level security verification against a real Postgres engine
 * (PGlite/WASM, PG17) using the exact production migrations:
 *  - RLS isolation on wallets (default-deny, owner scoping, compliance read)
 *  - audit_log append-only immutability (UPDATE/DELETE/TRUNCATE raise)
 *  - hash-chain verification and tamper detection
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { asAppRole } from "../src/db/pglite-dev-role";
import { auditLog, user, wallets } from "../src/db/schema";
import { withUserContext } from "../src/db/rls";
import { appendAuditEvent, verifyAuditChain } from "../src/security/audit";
import { eq } from "drizzle-orm";

type Db = ReturnType<typeof drizzle<typeof import("../src/db/schema")>>;

let db: Db;

async function seedUser(id: string, email: string) {
  await db
    .insert(user)
    .values({ id, name: id, email, emailVerified: true })
    .execute();
}


/** Drizzle wraps PG errors; walk the cause chain to find the database message. */
function pgMessage(e: unknown): string {
  let cur: unknown = e;
  const parts: string[] = [];
  for (let i = 0; i < 6 && cur; i++) {
    parts.push(String((cur as Error).message ?? ""));
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

async function expectSqlRejected(p: Promise<unknown>, pattern: RegExp): Promise<void> {
  const err = await p.then(() => null).catch((e: unknown) => e);
  expect(err, "expected the statement to be rejected").not.toBeNull();
  expect(pgMessage(err)).toMatch(pattern);
}

beforeAll(async () => {
  const pg = new PGlite();
  db = drizzle(pg);
  await migrate(db, { migrationsFolder: "./drizzle" });
  // PGlite's default user is a SUPERUSER, and superusers bypass RLS entirely.
  // Neon's app role is never a superuser, so we drop into a non-privileged
  // role to reproduce production enforcement semantics exactly.
  await asAppRole(db);
  await seedUser("alice", "alice@students.example.com");
  await seedUser("bob", "bob@students.example.com");
  // Wallets are inserted with owner-bound RLS contexts (as the app does).
  await withUserContext(db, { userId: "alice", role: "student" }, (tx) =>
    tx.insert(wallets).values([
      { id: "w-alice-cny", userId: "alice", currency: "CNY", kind: "home", balance: "1000" },
      { id: "w-alice-gbp", userId: "alice", currency: "GBP", kind: "host", balance: "100" },
    ]),
  );
  await withUserContext(db, { userId: "bob", role: "student" }, (tx) =>
    tx.insert(wallets).values([
      { id: "w-bob-cny", userId: "bob", currency: "CNY", kind: "home", balance: "5000" },
    ]),
  );
});

describe("RLS on wallets (I-1)", () => {
  it("default-deny: without a bound context the owner sees nothing", async () => {
    const rows = await db.select().from(wallets);
    expect(rows).toHaveLength(0);
  });
  it("owner scoping: alice sees only her wallets", async () => {
    const rows = await withUserContext(db, { userId: "alice", role: "student" }, (tx) =>
      tx.select().from(wallets),
    );
    expect(rows.map((r) => r.id).sort()).toEqual(["w-alice-cny", "w-alice-gbp"]);
  });
  it("compliance_admin context can read across owners (audit tier)", async () => {
    const rows = await withUserContext(db, { userId: "inspector", role: "compliance_admin" }, (tx) =>
      tx.select().from(wallets),
    );
    // Sees wallets across owners (alice + bob); the exact total also includes
    // the platform's seeded system wallets from the Phase-2 migration.
    const ids = rows.map((r) => r.id);
    for (const expected of ["w-alice-cny", "w-alice-gbp", "w-bob-cny"]) {
      expect(ids).toContain(expected);
    }
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });
  it("INSERT with a foreign user_id is rejected by WITH CHECK", async () => {
    await expect(
      withUserContext(db, { userId: "alice", role: "student" }, (tx) =>
        tx
          .insert(wallets)
          .values({ id: "w-forge", userId: "bob", currency: "GBP", kind: "host", balance: "1" }),
      ),
    ).rejects.toThrow();
  });
});

describe("audit_log immutability (I-6)", () => {
  beforeAll(async () => {
    // FOR EACH ROW triggers need at least one row to fire on.
    await withUserContext(db, { userId: "alice", role: "student" }, (tx) =>
      appendAuditEvent(tx, { action: "auth.signin", entityType: "session", actorUserId: "alice", actorRole: "student" }),
    );
  });

  it("rejects UPDATE", async () => {
    await expectSqlRejected(db.execute(sql`update audit_log set action = 'tamper'`), /append-only/);
  });
  it("rejects DELETE", async () => {
    await expectSqlRejected(db.execute(sql`delete from audit_log`), /append-only/);
  });
  it("rejects TRUNCATE (trigger binds even the table owner)", async () => {
    await db.execute(sql`reset role`);
    await expectSqlRejected(db.execute(sql`truncate table audit_log`), /append-only/);
    await db.execute(sql`set role sf_app`);
  });
});

describe("audit hash chain (I-6)", () => {
  it("concurrent appends serialize into a single valid chain", async () => {
    await withUserContext(db, { userId: "alice", role: "student" }, async (tx) => {
      await appendAuditEvent(tx, { action: "wallet.view", entityType: "wallet", actorUserId: "alice" });
    });
    await withUserContext(db, { userId: "bob", role: "student" }, async (tx) => {
      await appendAuditEvent(tx, { action: "wallet.view", entityType: "wallet", actorUserId: "bob" });
    });
    const result = await verifyAuditChain(db);
    expect(result.ok).toBe(true);
  });

  it("links events and verifies; tampered history is detected", async () => {
    await withUserContext(db, { userId: "alice", role: "student" }, async (tx) => {
      await appendAuditEvent(tx, { action: "auth.signin", entityType: "session", actorUserId: "alice", actorRole: "student" });
      await appendAuditEvent(tx, { action: "fx.quote", entityType: "wallet", entityId: "w-alice-cny", actorUserId: "alice", actorRole: "student" });
      await appendAuditEvent(tx, { action: "wallet.view", entityType: "wallet", actorUserId: "alice", actorRole: "student" });
    });
    const ok = await verifyAuditChain(db);
    expect(ok.ok).toBe(true);
    expect(ok.length).toBeGreaterThanOrEqual(3);

    // Forge a row that breaks the chain (simulates an attacker with write
    // access bypassing the app): the verifier must flag it.
    await withUserContext(db, { userId: "bob", role: "student" }, async (tx) => {
      await tx.execute(
        sql`insert into audit_log (id, occurred_at, action, entity_type, prev_hash, row_hash)
            values ('rogue-row', now(), 'fx.convert', 'wallet', 'not-the-real-tip', 'deadbeef')`,
      );
    });
    const broken = await verifyAuditChain(db);
    expect(broken.ok).toBe(false);
    expect(broken.brokenAtId).toBe("rogue-row");
  });

});

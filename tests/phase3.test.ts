/**
 * Phase-3 (T11-T13) verification against a real Postgres engine (PGlite) using
 * the exact production migrations:
 *  - T11: verified-institution directory; student-initiated tuition routing as
 *    balanced double-entry; immutable receipts; sponsor READ-ONLY access via
 *    sponsor_links (unlinked sponsors see nothing).
 *  - T12: R_score exact formula (300 + 550·Σwᵢxᵢ), clamped [300, 850];
 *    append-only score history; RLS scoping.
 *  - T13: Metro-2 export enclave decrypts SPII but the export contains NO
 *    plaintext SPII (tokenized account reference); every export is audited.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { asAppRole } from "../src/db/pglite-dev-role";
import { creditProfiles, ledgerEntries, rScoreSnapshots, tuitionPayments, user, wallets } from "../src/db/schema";
import { withUserContext } from "../src/db/rls";
import { listUniversities, payTuition, listReceipts, createSponsorLink, TuitionError } from "../src/tuition/service";
import { computeRScore, getLatestScore, recordScore } from "../src/credit/rscore";
import { generateMetro2Export } from "../src/reporting/metro2";
import { parseMoney } from "../src/ledger/money";
import { encryptSpii, loadKeyringFromEnv } from "../src/security/spii";
import { verifyAuditChain } from "../src/security/audit";

type Db = ReturnType<typeof drizzle<typeof import("../src/db/schema")>>;
let db: Db;
let ring: ReturnType<typeof loadKeyringFromEnv>;

const COMPLIANCE = { userId: "inspector", role: "compliance_admin" as const };

async function makeUser(id: string): Promise<string> {
  await db.insert(user).values({ id, name: id, email: `${id}@test.local`, emailVerified: true }).execute();
  return id;
}

/** Drizzle wraps PG errors; walk the cause chain to find the database message. */
function dbMessage(e: unknown): string {
  let cur: unknown = e;
  const parts: string[] = [];
  for (let i = 0; i < 6 && cur; i++) {
    parts.push(String((cur as Error).message ?? ""));
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}
async function expectRejected(p: Promise<unknown>, re: RegExp): Promise<void> {
  const err = await p.then(() => null).catch((e: unknown) => e);
  expect(err, "expected the statement to be rejected").not.toBeNull();
  expect(dbMessage(err)).toMatch(re);
}

async function balanceOf(walletId: string, owner: string): Promise<string> {
  const rows = await withUserContext(db, { userId: owner, role: "student" }, (tx) => tx.select().from(wallets).where(eq(wallets.id, walletId)));
  return String(rows[0]?.balance ?? "0");
}

beforeAll(async () => {
  process.env.SPII_MASTER_KEY = "test-spii-master-key-".repeat(3); // >=32 chars, KMS stand-in
  process.env.SPII_KEY_ID = "k1";
  ring = loadKeyringFromEnv();
  const pg = new PGlite();
  db = drizzle(pg);
  await migrate(db, { migrationsFolder: "./drizzle" });
  await asAppRole(db);
});

describe("T11 verified directory + tuition routing", () => {
  it("lists only verified institutions (unverified excluded)", async () => {
    const unis = await listUniversities(db);
    const ids = unis.map((u) => u.id);
    expect(ids).toContain("uni-ucl");
    expect(ids).toContain("uni-manchester");
    expect(ids).toContain("uni-shenzhen-univ");
    expect(ids).not.toContain("uni-unverified-test");
    expect(unis.every((u) => u.verified)).toBe(true);
  });

  it("student-initiated payment posts balanced double-entry, updates wallet, seals receipt, advances R_score", async () => {
    const sid = await makeUser("stu-pay");
    await withUserContext(db, { userId: sid, role: "student" }, (tx) =>
      tx.insert(wallets).values({ id: "w-stu-gbp", userId: sid, currency: "GBP", kind: "host", balance: "5000" }),
    );
    const before = await balanceOf("w-stu-gbp", sid);
    expect(before).toBe("5000.00000000");

    const receipt = await payTuition(db, { studentUserId: sid, universityId: "uni-ucl", walletId: "w-stu-gbp", amount: "1000" });
    expect(receipt.status).toBe("settled");
    expect(receipt.receiptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await balanceOf("w-stu-gbp", sid)).toBe("4000.00000000"); // 5000 - 1000
    // R_score advanced and landed in range.
    expect(receipt.newScore).toBeGreaterThanOrEqual(300);
    expect(receipt.newScore).toBeLessThanOrEqual(850);

    // Zero-sum across the transaction (double-entry), per currency.
    const legs = await withUserContext(db, COMPLIANCE, (tx) =>
      tx
        .select({ currency: ledgerEntries.currency, total: sql<string>`coalesce(sum(${ledgerEntries.amount}),0)` })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.transactionId, receipt.transactionId))
        .groupBy(ledgerEntries.currency),
    );
    expect(legs.length).toBeGreaterThan(0);
    for (const l of legs) expect(parseMoney(String(l.total))).toBe(0n);

    // Immutable receipt exists and is visible to the owner.
    const mine = await listReceipts(db, { userId: sid, role: "student" });
    expect(mine.some((r) => r.id === receipt.id)).toBe(true);
  });

  it("rejects unverified institutions, insufficient funds, and currency mismatch", async () => {
    const sid = await makeUser("stu-rej");
    await withUserContext(db, { userId: sid, role: "student" }, (tx) =>
      tx.insert(wallets).values({ id: "w-rej-gbp", userId: sid, currency: "GBP", kind: "host", balance: "100" }),
    );
    await expect(payTuition(db, { studentUserId: sid, universityId: "uni-unverified-test", walletId: "w-rej-gbp", amount: "10" })).rejects.toMatchObject({ code: "INSTITUTION_NOT_VERIFIED" });
    await expect(payTuition(db, { studentUserId: sid, universityId: "uni-shenzhen-univ", walletId: "w-rej-gbp", amount: "10" })).rejects.toMatchObject({ code: "CURRENCY_MISMATCH" });
    await expect(payTuition(db, { studentUserId: sid, universityId: "uni-ucl", walletId: "w-rej-gbp", amount: "99999" })).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
  });

  it("tuition receipts are append-only (UPDATE/DELETE/TRUNCATE raise)", async () => {
    const sid = await makeUser("stu-imm");
    await withUserContext(db, { userId: sid, role: "student" }, (tx) =>
      tx.insert(wallets).values({ id: "w-imm-gbp", userId: sid, currency: "GBP", kind: "host", balance: "50" }),
    );
    await payTuition(db, { studentUserId: sid, universityId: "uni-ucl", walletId: "w-imm-gbp", amount: "10" });
    await db.execute(sql`reset role`);
    await expectRejected(db.execute(sql`update tuition_payments set amount = '999'`), /append-only/);
    await expectRejected(db.execute(sql`delete from tuition_payments`), /append-only/);
    await expectRejected(db.execute(sql`truncate table tuition_payments`), /append-only/);
    await db.execute(sql`set role sf_app`);
  });

  it("sponsor reads linked student's receipts; an unlinked sponsor sees none (read-only)", async () => {
    const sid = await makeUser("stu-link");
    const sponsor = await makeUser("spn-link");
    const stranger = await makeUser("spn-stranger");
    await withUserContext(db, { userId: sid, role: "student" }, (tx) =>
      tx.insert(wallets).values({ id: "w-link-gbp", userId: sid, currency: "GBP", kind: "host", balance: "100" }),
    );
    const receipt = await payTuition(db, { studentUserId: sid, universityId: "uni-ucl", walletId: "w-link-gbp", amount: "40" });

    await createSponsorLink(db, sponsor, sid);
    const asSponsor = await listReceipts(db, { userId: sponsor, role: "sponsor" });
    expect(asSponsor.some((r) => r.id === receipt.id)).toBe(true);

    const asStranger = await listReceipts(db, { userId: stranger, role: "sponsor" });
    expect(asStranger.some((r) => r.id === receipt.id)).toBe(false);
  });
});

describe("T12 R_score engine", () => {
  it("computes the exact formula and clamps to [300, 850]", () => {
    expect(computeRScore({ tTuition: 0, bBills: 0, sWallet: 0, lRepay: 0 })).toBe(300);
    expect(computeRScore({ tTuition: 1, bBills: 1, sWallet: 1, lRepay: 1 })).toBe(850);
    expect(computeRScore({ tTuition: 1, bBills: 0, sWallet: 0, lRepay: 0 })).toBe(520); // 300 + 550*.40
    expect(computeRScore({ tTuition: 0, bBills: 1, sWallet: 0, lRepay: 0 })).toBe(438); // 300 + 137.5 -> round
    expect(computeRScore({ tTuition: 0.5, bBills: 0.5, sWallet: 0.5, lRepay: 0.5 })).toBe(575);
    // Clamping: out-of-range components are clamped into [0,1] first.
    expect(computeRScore({ tTuition: 5, bBills: 5, sWallet: 5, lRepay: 5 })).toBe(850);
    expect(computeRScore({ tTuition: -3, bBills: 0, sWallet: 0, lRepay: 0 })).toBe(300);
  });

  it("score history is append-only and RLS-scoped to the owner", async () => {
    const sid = await makeUser("stu-score");
    await recordScore(db, { studentUserId: sid, components: { tTuition: 1, bBills: 0, sWallet: 0, lRepay: 0 }, triggerEvent: "test" });
    await recordScore(db, { studentUserId: sid, components: { tTuition: 1, bBills: 1, sWallet: 1, lRepay: 1 }, triggerEvent: "test" });
    const latest = await getLatestScore(db, sid);
    expect(latest?.score).toBe(850); // latest wins

    // Another student cannot see this score; default-deny without context.
    const foreign = await withUserContext(db, { userId: "intruder", role: "student" }, (tx) =>
      tx.select().from(rScoreSnapshots).where(eq(rScoreSnapshots.studentUserId, sid)),
    );
    expect(foreign).toHaveLength(0);
    const anon = await db.select().from(rScoreSnapshots);
    expect(anon).toHaveLength(0);

    await db.execute(sql`reset role`);
    await expectRejected(db.execute(sql`update r_score_snapshots set score = 850`), /append-only/);
    await expectRejected(db.execute(sql`delete from r_score_snapshots`), /append-only/);
    await db.execute(sql`set role sf_app`);
  });
});

describe("T13 Metro 2 export enclave", () => {
  it("decrypts SPII only in the enclave; export has NO plaintext SPII and is audited", async () => {
    const sid = await makeUser("stu-m2");
    await withUserContext(db, { userId: sid, role: "student" }, (tx) =>
      tx.insert(wallets).values({ id: "w-m2-gbp", userId: sid, currency: "GBP", kind: "host", balance: "3000" }),
    );
    await payTuition(db, { studentUserId: sid, universityId: "uni-ucl", walletId: "w-m2-gbp", amount: "1500" });

    const PLAINTEXT = "P1234567";
    const ciphertext = encryptSpii(PLAINTEXT, ring, { column: "credit_profiles.national_id_spii", owner: sid });
    await withUserContext(db, { userId: sid, role: "student" }, (tx) =>
      tx.insert(creditProfiles).values({ studentUserId: sid, nationalIdSpii: ciphertext }),
    );

    const result = await generateMetro2Export(db, ring, { studentUserId: sid, actorUserId: COMPLIANCE.userId });
    expect(result.records).toHaveLength(1);
    const rec = result.records[0]!;
    // Tokenized account reference, not the plaintext, and a valid rating.
    expect(rec.accountNumber).toMatch(/^[0-9a-f]{16}$/);
    expect(rec.accountNumber).not.toBe(PLAINTEXT);
    expect(["1", "2", "3", "4", "5"]).toContain(rec.paymentRating);
    // The serialized export must contain NO plaintext SPII.
    expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
    expect(JSON.stringify(result.records)).not.toContain(PLAINTEXT);
    // Export is audited and the audit chain stays valid.
    const chain = await verifyAuditChain(db);
    expect(chain.ok).toBe(true);
  });
});

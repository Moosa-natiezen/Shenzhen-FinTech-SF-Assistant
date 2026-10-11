/**
 * Phase-2 ledger engine verification against a real Postgres engine (PGlite)
 * using the exact production migrations. Covers T7-T10 and the money invariants:
 *  - double-entry zero-sum per currency; engine rejects unbalanced/one-leg/zero postings
 *  - cached wallet.balance always equals SUM(ledger_entries.amount) (derived state)
 *  - server-side FX: fxFinal = spot x (1+margin) exactly; client cannot inject a rate;
 *    rate locks are single-use, expiring, and amount-bound
 *  - atomic conversions with SELECT ... FOR UPDATE: N parallel conversions, exactly
 *    one wins per balance (no overdraft / lost update)
 *  - deposits + cross-border transfers post balanced legs; velocity caps enforced
 *  - screening block-on-miss; append-only immutability; RLS isolation on the ledger
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { asAppRole } from "../src/db/pglite-dev-role";
import { ledgerEntries, rateLocks, transfers, user, wallets } from "../src/db/schema";
import { withUserContext } from "../src/db/rls";
import { deriveBalance, postLedgerTransaction, LedgerError } from "../src/ledger/engine";
import { parseMoney } from "../src/ledger/money";
import { computeFxFinal, getLiveLock, lockRate } from "../src/fx/service";
import { convertFunds } from "../src/ledger/conversion";
import { depositFunds, transferFunds, screenOrBlock } from "../src/transfers/service";
import { verifyAuditChain } from "../src/security/audit";

type Db = ReturnType<typeof drizzle<typeof import("../src/db/schema")>>;
let db: Db;

const HIGH_CAPS = { perTx: "10000000", daily: "10000000", cumulative: "10000000" };

/** Seeds a user with an empty CNY (home) + GBP (host) wallet pair. */
async function makeAccount(prefix: string) {
  const userId = `${prefix}-user`;
  await db.insert(user).values({ id: userId, name: userId, email: `${prefix}@test.local`, emailVerified: true }).execute();
  await withUserContext(db, { userId, role: "student" }, (tx) =>
    tx.insert(wallets).values([
      { id: `${prefix}-cny`, userId, currency: "CNY", kind: "home", balance: "0" },
      { id: `${prefix}-gbp`, userId, currency: "GBP", kind: "host", balance: "0" },
    ]),
  );
  return { userId, cny: `${prefix}-cny`, gbp: `${prefix}-gbp` };
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
  const rows = await withUserContext(db, { userId: owner, role: "student" }, (tx) =>
    tx.select().from(wallets).where(eq(wallets.id, walletId)),
  );
  return String(rows[0]?.balance ?? "0");
}

/** Asserts the cached balance equals the SUM(ledger_entries) derivation. */
async function assertDerived(walletId: string, owner: string): Promise<void> {
  const cached = await balanceOf(walletId, owner);
  const derived = await deriveBalance(db, walletId, owner);
  expect(parseMoney(cached)).toBe(parseMoney(derived));
}

/** Asserts every currency's legs for one transactionId sum to exactly zero. */
async function assertZeroSum(transactionId: string): Promise<void> {
  const rows = await withUserContext(db, { userId: "inspector", role: "compliance_admin" }, (tx) =>
    tx
      .select({ currency: ledgerEntries.currency, total: sql<string>`coalesce(sum(${ledgerEntries.amount}),0)` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, transactionId))
      .groupBy(ledgerEntries.currency),
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) expect(parseMoney(String(r.total))).toBe(0n);
}

beforeAll(async () => {
  const pg = new PGlite();
  db = drizzle(pg);
  await migrate(db, { migrationsFolder: "./drizzle" });
  await asAppRole(db); // drop into the non-superuser app role (RLS binds)
});

describe("T7 double-entry ledger engine", () => {
  it("rejects unbalanced, single-leg, zero-amount, and malformed postings", async () => {
    await expect(postLedgerTransaction(db, { legs: [{ walletId: "x", userId: "u", currency: "CNY", amount: "10", kind: "k" }] })).rejects.toMatchObject({ code: "UNBALANCED" });
    await expect(
      postLedgerTransaction(db, {
        legs: [
          { walletId: "x", userId: "u", currency: "CNY", amount: "-10", kind: "k" },
          { walletId: "y", userId: "u", currency: "CNY", amount: "9", kind: "k" },
        ],
      }),
    ).rejects.toMatchObject({ code: "UNBALANCED" });
    await expect(
      postLedgerTransaction(db, {
        legs: [
          { walletId: "x", userId: "u", currency: "CNY", amount: "-10", kind: "k" },
          { walletId: "y", userId: "u", currency: "CNY", amount: "0", kind: "k" },
        ],
      }),
    ).rejects.toMatchObject({ code: "ZERO_LEG" });
    await expect(
      postLedgerTransaction(db, {
        legs: [
          { walletId: "x", userId: "u", currency: "CNY", amount: "abc", kind: "k" },
          { walletId: "y", userId: "u", currency: "CNY", amount: "-abc", kind: "k" },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_AMOUNT" });
  });

  it("deposit posts a balanced pair, updates cached balances, and keeps derived state", async () => {
    const a = await makeAccount("dep");
    const res = await depositFunds(db, { sponsorUserId: a.userId, walletId: a.cny, amount: "1000", caps: HIGH_CAPS });
    expect(await balanceOf(a.cny, a.userId)).toBe("1000.00000000");
    await assertZeroSum(res.transactionId);
    await assertDerived(a.cny, a.userId);
  });

  it("append-only: ledger_entries and balance_snapshots reject UPDATE/DELETE/TRUNCATE", async () => {
    const a = await makeAccount("imm");
    await depositFunds(db, { sponsorUserId: a.userId, walletId: a.cny, amount: "10", caps: HIGH_CAPS });
    // Drop to superuser: RLS is bypassed, proving the append-only TRIGGERS
    // themselves bind even the most privileged role (same shape as audit_log).
    await db.execute(sql`reset role`);
    await expectRejected(db.execute(sql`update ledger_entries set amount = '999'`), /append-only/);
    await expectRejected(db.execute(sql`delete from ledger_entries`), /append-only/);
    await expectRejected(db.execute(sql`truncate table balance_snapshots`), /append-only/);
    await db.execute(sql`set role sf_app`);
  });
});

describe("T8 server-side FX pricing (invariant I-4)", () => {
  it("computes fxFinal = spot x (1 + margin) exactly", async () => {
    expect(computeFxFinal("0.11", "0.002")).toBe("0.11022000");
    const lock = await lockRate(db, { userId: (await makeAccount("fxm")).userId, baseCurrency: "CNY", quoteCurrency: "GBP", amountBase: "100" });
    expect(lock.fxSpot).toBe("0.11");
    expect(lock.fxFinal).toBe("0.11022000");
  });

  it("ignores client rates: the API takes no rate, and a missing/expired/foreign/wrong-amount lock is rejected", async () => {
    const a = await makeAccount("fxr");
    await depositFunds(db, { sponsorUserId: a.userId, walletId: a.cny, amount: "2000", caps: HIGH_CAPS });
    // No rate parameter exists on convertFunds; without a lock it cannot run.
    await expect(
      convertFunds(db, { userId: a.userId, homeWalletId: a.cny, hostWalletId: a.gbp, amountBase: "100" } as any),
    ).rejects.toMatchObject({ code: "FX_LOCK_REQUIRED" });

    const lock = await lockRate(db, { userId: a.userId, baseCurrency: "CNY", quoteCurrency: "GBP", amountBase: "100" });
    // Wrong amount against the same lock -> rejected (amount-bound).
    await expect(
      convertFunds(db, { userId: a.userId, homeWalletId: a.cny, hostWalletId: a.gbp, amountBase: "250", rateLockId: lock.id }),
    ).rejects.toMatchObject({ code: "FX_LOCK_AMOUNT" });
    // A different user cannot consume someone else's lock.
    const b = await makeAccount("fxo");
    await expect(
      convertFunds(db, { userId: b.userId, homeWalletId: b.cny, hostWalletId: b.gbp, amountBase: "100", rateLockId: lock.id }),
    ).rejects.toMatchObject({ code: "FX_LOCK_NOT_FOUND" });
  });

  it("expires locks and forbids reuse (single-use)", async () => {
    const a = await makeAccount("fxt");
    await depositFunds(db, { sponsorUserId: a.userId, walletId: a.cny, amount: "1000", caps: HIGH_CAPS });
    const expiring = await lockRate(db, { userId: a.userId, baseCurrency: "CNY", quoteCurrency: "GBP", amountBase: "100", ttlSeconds: -1 });
    await expect(
      convertFunds(db, { userId: a.userId, homeWalletId: a.cny, hostWalletId: a.gbp, amountBase: "100", rateLockId: expiring.id }),
    ).rejects.toMatchObject({ code: "FX_LOCK_EXPIRED" });

    const lock = await lockRate(db, { userId: a.userId, baseCurrency: "CNY", quoteCurrency: "GBP", amountBase: "100" });
    await convertFunds(db, { userId: a.userId, homeWalletId: a.cny, hostWalletId: a.gbp, amountBase: "100", rateLockId: lock.id });
    // Consumed: no longer live, and cannot be consumed again.
    expect(await getLiveLock(db, lock.id, a.userId)).toBeNull();
    await expect(
      convertFunds(db, { userId: a.userId, homeWalletId: a.cny, hostWalletId: a.gbp, amountBase: "100", rateLockId: lock.id }),
    ).rejects.toMatchObject({ code: "FX_LOCK_CONSUMED" });
  });
});

describe("T9 atomic conversion (FOR UPDATE, exactness)", () => {
  it("converts home->host at the locked rate, posts balanced legs, keeps derived state", async () => {
    const a = await makeAccount("cv");
    await depositFunds(db, { sponsorUserId: a.userId, walletId: a.cny, amount: "1000", caps: HIGH_CAPS });
    const lock = await lockRate(db, { userId: a.userId, baseCurrency: "CNY", quoteCurrency: "GBP", amountBase: "1000", feeFlat: "2" });
    const res = await convertFunds(db, { userId: a.userId, homeWalletId: a.cny, hostWalletId: a.gbp, amountBase: "1000", rateLockId: lock.id });

    expect(res.fxFinal).toBe("0.11022000");
    // (1000 - 2) * 0.11022 = 109.99956
    expect(res.hostCredited).toBe("109.99956000");
    expect(await balanceOf(a.cny, a.userId)).toBe("0.00000000"); // 1000 - 1000
    expect(await balanceOf(a.gbp, a.userId)).toBe("109.99956000");
    await assertZeroSum(res.transactionId);
    await assertDerived(a.cny, a.userId);
    await assertDerived(a.gbp, a.userId);
  });

  it("N parallel conversions of the same size: exactly one wins, no overdraft", async () => {
    const a = await makeAccount("par");
    await depositFunds(db, { sponsorUserId: a.userId, walletId: a.cny, amount: "1000", caps: HIGH_CAPS });
    // Three conversions of 600; only one fits in 1000.
    const locks = await Promise.all(
      [0, 1, 2].map(() => lockRate(db, { userId: a.userId, baseCurrency: "CNY", quoteCurrency: "GBP", amountBase: "600" })),
    );
    const results = await Promise.allSettled(
      locks.map((l) => convertFunds(db, { userId: a.userId, homeWalletId: a.cny, hostWalletId: a.gbp, amountBase: "600", rateLockId: l.id })),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);
    for (const l of lost) expect((l.reason as LedgerError).code).toBe("INSUFFICIENT_FUNDS");
    expect(await balanceOf(a.cny, a.userId)).toBe("400.00000000"); // 1000 - 600
    expect(await balanceOf(a.gbp, a.userId)).toBe("66.13200000"); // 600 * 0.11022
    await assertDerived(a.cny, a.userId);
    await assertDerived(a.gbp, a.userId);
  });
});

describe("T10 deposits & cross-border transfers", () => {
  it("same-currency transfer is a balanced 2-leg posting", async () => {
    const s = await makeAccount("tsrc");
    const r = await makeAccount("trcp");
    await depositFunds(db, { sponsorUserId: s.userId, walletId: s.cny, amount: "500", caps: HIGH_CAPS });
    const res = await transferFunds(db, { senderUserId: s.userId, recipientUserId: r.userId, fromWalletId: s.cny, toWalletId: r.cny, amountFrom: "200" });
    expect(res.amountTo).toBe("200.00000000");
    expect(res.fxFinal).toBeNull();
    expect(await balanceOf(s.cny, s.userId)).toBe("300.00000000");
    expect(await balanceOf(r.cny, r.userId)).toBe("200.00000000");
    await assertZeroSum(res.transactionId);
    await assertDerived(s.cny, s.userId);
    await assertDerived(r.cny, r.userId);
    // Recorded in the transfers table under the sender's visibility.
    const rows = await withUserContext(db, { userId: s.userId, role: "student" }, (tx) => tx.select().from(transfers));
    expect(rows.some((t) => t.id === res.transferId)).toBe(true);
  });

  it("cross-currency transfer consumes a lock and credits the recipient's host wallet", async () => {
    const s = await makeAccount("xsrc");
    const r = await makeAccount("xrcp");
    await depositFunds(db, { sponsorUserId: s.userId, walletId: s.cny, amount: "1000", caps: HIGH_CAPS });
    const lock = await lockRate(db, { userId: s.userId, baseCurrency: "CNY", quoteCurrency: "GBP", amountBase: "1000", feeFlat: "10" });
    const res = await transferFunds(db, {
      senderUserId: s.userId, recipientUserId: r.userId, fromWalletId: s.cny, toWalletId: r.gbp, amountFrom: "1000", rateLockId: lock.id,
    });
    // (1000 - 10) * 0.11022 = 109.1178
    expect(res.amountTo).toBe("109.11780000");
    expect(await balanceOf(s.cny, s.userId)).toBe("0.00000000");
    expect(await balanceOf(r.gbp, r.userId)).toBe("109.11780000");
    await assertZeroSum(res.transactionId);
    await assertDerived(r.gbp, r.userId);
  });

  it("enforces per-tx and daily velocity caps", async () => {
    const s = await makeAccount("cap");
    await depositFunds(db, { sponsorUserId: s.userId, walletId: s.cny, amount: "1000", caps: HIGH_CAPS });
    await expect(depositFunds(db, { sponsorUserId: s.userId, walletId: s.cny, amount: "1000", caps: { perTx: "500" } })).rejects.toMatchObject({ code: "CAP_EXCEEDED" });
    await expect(depositFunds(db, { sponsorUserId: s.userId, walletId: s.cny, amount: "600", caps: { perTx: "10000", daily: "500" } })).rejects.toMatchObject({ code: "CAP_EXCEEDED" });
  });

  it("screening is block-on-miss: an unknown/failed decision blocks", async () => {
    expect((await screenOrBlock("u", 1n)).blocked).toBe(false);
    expect((await screenOrBlock("u", 1n, async () => ({ blocked: true, reason: "sanctions" }))).blocked).toBe(true);
    expect((await screenOrBlock("u", 1n, async () => { throw new Error("provider down"); })).blocked).toBe(true);
    expect((await screenOrBlock("u", 1n, async () => ({} as any))).blocked).toBe(true); // no decision => miss
  });
});

describe("RLS isolation + audit integrity across the ledger", () => {
  it("a foreign context cannot read another user's ledger entries; none sees anything by default", async () => {
    const a = await makeAccount("rls");
    await depositFunds(db, { sponsorUserId: a.userId, walletId: a.cny, amount: "42", caps: HIGH_CAPS });
    const foreign = await withUserContext(db, { userId: "intruder", role: "student" }, (tx) =>
      tx.select().from(ledgerEntries).where(eq(ledgerEntries.walletId, a.cny)),
    );
    expect(foreign).toHaveLength(0);
    const anon = await db.select().from(ledgerEntries);
    expect(anon).toHaveLength(0);
    const mine = await withUserContext(db, { userId: a.userId, role: "student" }, (tx) =>
      tx.select().from(ledgerEntries).where(eq(ledgerEntries.walletId, a.cny)),
    );
    expect(mine.length).toBeGreaterThan(0);
  });

  it("audit chain stays valid after ledger activity", async () => {
    const a = await makeAccount("aud");
    await depositFunds(db, { sponsorUserId: a.userId, walletId: a.cny, amount: "7", caps: HIGH_CAPS });
    const lock = await lockRate(db, { userId: a.userId, baseCurrency: "CNY", quoteCurrency: "GBP", amountBase: "7" });
    await convertFunds(db, { userId: a.userId, homeWalletId: a.cny, hostWalletId: a.gbp, amountBase: "7", rateLockId: lock.id });
    const chain = await verifyAuditChain(db);
    expect(chain.ok).toBe(true);
  });
});

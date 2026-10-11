/**
 * FX rate service (T8) — server-side computation only (invariant I-4).
 *
 *  - FX_final = FX_spot × (1 + θ_margin). The spot rate is fetched from a
 *    server-side provider (mock here; the seam is `fetchSpotRate`), NEVER from
 *    the client. The public API accepts no rate argument at all, so a client
 *    rate literally cannot influence the outcome.
 *  - Exact decimal math (money.ts): spot/margin/final are carried as scaled
 *    BigInt; the stored `fx_final` (8 dp) is the exact value used downstream, so
 *    the locked rate and the executed rate can never diverge.
 *  - Short-lived (default 30s) single-use rate locks, hash-chain audited. A
 *    conversion must present a live, unconsumed lock.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { rateLocks } from "../db/schema";
import { withContextSwitching } from "../db/rls";
import type { AnyPgDatabase } from "../db/types";
import { appendAuditEvent } from "../security/audit";
import { formatMoney, mulScaled, parseMoney } from "../ledger/money";
import { LedgerError } from "../ledger/engine";

/** Default conservative margin θ = 20 bps = 0.2%. */
export const DEFAULT_MARGIN = "0.002";
export const DEFAULT_LOCK_TTL_SECONDS = 30;

/**
 * Mock server-side spot provider. In production this is the FX provider seam
 * (design doc §5 "Integrations"): replace the body with a real HTTP call, keep
 * the exact-decimal contract. Rates are per 1 unit of base in quote terms.
 */
const MOCK_SPOT: Record<string, string> = {
  "CNY:GBP": "0.11",
  "GBP:CNY": "9.09",
  "USD:CNY": "7.2",
  "CNY:USD": "0.13888889",
  "USD:GBP": "0.79",
  "GBP:USD": "1.26582278",
};

export async function fetchSpotRate(base: string, quote: string): Promise<string> {
  const b = base.toUpperCase();
  const q = quote.toUpperCase();
  if (b === q) return "1.00000000";
  const rate = MOCK_SPOT[`${b}:${q}`];
  if (!rate) throw new LedgerError(`no spot rate available for ${b}/${q}`, "FX_NO_RATE");
  return rate;
}

export interface LockRateInput {
  userId: string;
  baseCurrency: string;
  quoteCurrency: string;
  amountBase: string; // source amount in base currency (decimal string)
  feeFlat?: string; // flat fee retained in base currency (decimal string)
  margin?: string; // override θ (defaults to DEFAULT_MARGIN)
  ttlSeconds?: number;
}

export interface RateLock {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  fxSpot: string;
  fxFinal: string;
  margin: string;
  amountBase: string;
  feeFlat: string;
  expiresAt: Date;
}

/** Computes FX_final = spot × (1 + margin) exactly, rounded to 8 dp. */
export function computeFxFinal(fxSpot: string, margin: string): string {
  const onePlusMargin = parseMoney("1") + parseMoney(margin);
  return formatMoney(mulScaled(parseMoney(fxSpot), onePlusMargin));
}

/**
 * Creates a server-priced rate lock for a user. `amountBase`/`feeFlat` bind the
 * lock to a specific quote so it cannot be reused for a different size.
 */
export async function lockRate(db: AnyPgDatabase, input: LockRateInput): Promise<RateLock> {
  const base = input.baseCurrency.toUpperCase();
  const quote = input.quoteCurrency.toUpperCase();
  if (base === quote) throw new LedgerError("FX lock requires a cross-currency pair", "FX_SAME_CURRENCY");
  const margin = input.margin ?? DEFAULT_MARGIN;
  const feeFlat = input.feeFlat ?? "0";
  const fxSpot = await fetchSpotRate(base, quote);
  const fxFinal = computeFxFinal(fxSpot, margin);
  const ttl = (input.ttlSeconds ?? DEFAULT_LOCK_TTL_SECONDS) * 1000;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl);
  const id = randomUUID();

  await withContextSwitching(db, async (tx, bind) => {
    await bind({ userId: input.userId, role: "student" });
    await tx.insert(rateLocks).values({
      id,
      userId: input.userId,
      baseCurrency: base,
      quoteCurrency: quote,
      fxSpot,
      fxFinal,
      margin,
      amountBase: input.amountBase,
      feeFlat,
      lockedAt: now,
      expiresAt,
    });
    await appendAuditEvent(tx, {
      action: "fx.rate.lock",
      actorUserId: input.userId,
      actorRole: "student",
      entityType: "rate_lock",
      entityId: id,
      details: { base, quote, fxSpot, fxFinal, margin, amountBase: input.amountBase, feeFlat },
    });
  });

  return { id, baseCurrency: base, quoteCurrency: quote, fxSpot, fxFinal, margin, amountBase: input.amountBase, feeFlat, expiresAt };
}

/**
 * Loads a live, unconsumed lock FOR UPDATE inside an open transaction, under
 * the owner's RLS context. Verifies ownership, currency pair, amount binding,
 * expiry and single-use. Throws LedgerError when the lock is not usable.
 */
export async function consumeRateLockInTx(
  tx: any,
  bind: (ctx: any) => Promise<void>,
  lockId: string,
  expect: { userId: string; baseCurrency: string; quoteCurrency: string; amountBase: string },
): Promise<RateLock> {
  await bind({ userId: expect.userId, role: "student" });
  const [lock] = await tx.select().from(rateLocks).where(eq(rateLocks.id, lockId)).for("update");
  if (!lock) throw new LedgerError(`rate lock ${lockId} not found`, "FX_LOCK_NOT_FOUND");
  if (lock.userId !== expect.userId) throw new LedgerError("rate lock does not belong to this user", "FX_LOCK_OWNER");
  if (lock.consumedAt) throw new LedgerError("rate lock already consumed", "FX_LOCK_CONSUMED");
  if (new Date(lock.expiresAt).getTime() < Date.now()) throw new LedgerError("rate lock expired", "FX_LOCK_EXPIRED");
  // Pair check is applied only when the caller states an expected pair; the
  // conversion executor instead verifies wallet currencies against the lock.
  if (expect.baseCurrency) {
    if (lock.baseCurrency !== expect.baseCurrency.toUpperCase() || lock.quoteCurrency !== expect.quoteCurrency.toUpperCase()) {
      throw new LedgerError("rate lock currency pair mismatch", "FX_LOCK_PAIR");
    }
  }
  if (formatMoney(parseMoney(lock.amountBase)) !== formatMoney(parseMoney(expect.amountBase))) {
    throw new LedgerError("rate lock amount does not match conversion amount", "FX_LOCK_AMOUNT");
  }
  // Mark consumed (single-use) within the same transaction.
  await tx.update(rateLocks).set({ consumedAt: new Date() }).where(eq(rateLocks.id, lockId));
  return lock as unknown as RateLock;
}

/** Non-locking read helper (quotes/UI). Returns null when absent/expired. */
export async function getLiveLock(db: AnyPgDatabase, lockId: string, userId: string): Promise<RateLock | null> {
  return withContextSwitching(db, async (tx, bind) => {
    await bind({ userId, role: "student" });
    const [lock] = await tx
      .select()
      .from(rateLocks)
      .where(and(eq(rateLocks.id, lockId), eq(rateLocks.userId, userId), isNull(rateLocks.consumedAt)));
    if (!lock || new Date(lock.expiresAt).getTime() < Date.now()) return null;
    return lock as unknown as RateLock;
  });
}

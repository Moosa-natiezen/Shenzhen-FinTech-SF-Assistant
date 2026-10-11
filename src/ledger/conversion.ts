/**
 * Atomic conversion executor (T9).
 *
 * Executes a single user's home->host conversion using a LIVE server-side rate
 * lock (invariant I-4): the client never supplies a rate. Money movement, per
 * the design's exactness rule:
 *   debit  home wallet            − amountBase
 *   credit system base wallet     + amountBase            (system takes the base)
 *   credit host wallet            + (amountBase − feeFlat) × FX_final
 *   debit  system quote wallet    − (amountBase − feeFlat) × FX_final
 * Within each currency the legs sum to zero (balanced double-entry). The whole
 * conversion + lock consumption + audit commits or rolls back in ONE transaction
 * (I-3), with FOR UPDATE row locks on both wallets and the rate lock.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { wallets } from "../db/schema";
import { SYSTEM_USER_ID, withContextSwitching } from "../db/rls";
import type { AnyPgDatabase } from "../db/types";
import { appendAuditEvent } from "../security/audit";
import { formatMoney, mulScaled, parseMoney } from "./money";
import { applyLegsInTx, LedgerError, resolveSystemWalletId } from "./engine";
import { consumeRateLockInTx } from "../fx/service";

export interface ConvertInput {
  userId: string;
  homeWalletId: string; // base-currency wallet to debit
  hostWalletId: string; // quote-currency wallet to credit
  amountBase: string; // base amount to convert (decimal string)
  rateLockId: string; // live server-side lock
  feeFlat?: string; // flat base-currency fee (defaults to the lock's fee)
}

export interface ConvertResult {
  transactionId: string;
  fxFinal: string;
  feeFlat: string;
  amountBase: string;
  hostCredited: string; // (amountBase − feeFlat) × FX_final
  homeBalance: string; // post-conversion cached balance
  hostBalance: string;
}

export async function convertFunds(db: AnyPgDatabase, input: ConvertInput): Promise<ConvertResult> {
  // A conversion cannot execute without a live server-side lock (invariant I-4):
  // the client supplies a lock id, never a rate.
  if (!input.rateLockId) {
    throw new LedgerError("conversion requires a rate lock", "FX_LOCK_REQUIRED");
  }
  const transactionId = randomUUID();

  return withContextSwitching(db, async (tx, bind) => {
    // 1) Consume the lock under the owner's context (verifies pair/amount/expiry/single-use).
    //    We do not yet know base/quote, so read the lock once to learn them, then re-verify.
    // Empty pair => skip the in-lock pair check; we verify currencies against the
    // actual wallets below. Ownership/expiry/single-use/amount are still enforced.
    const lock = await consumeRateLockInTx(tx, bind, input.rateLockId, {
      userId: input.userId,
      baseCurrency: "",
      quoteCurrency: "",
      amountBase: input.amountBase,
    });
    const base = lock.baseCurrency;
    const quote = lock.quoteCurrency;
    const feeFlat = input.feeFlat ?? lock.feeFlat;
    const fxFinal = lock.fxFinal;

    // 2) Load + row-lock the home wallet under the owner context; check funds.
    await bind({ userId: input.userId, role: "student" });
    const [home] = await tx.select().from(wallets).where(eq(wallets.id, input.homeWalletId)).for("update");
    if (!home || home.userId !== input.userId) throw new LedgerError("home wallet not found", "WALLET_NOT_FOUND");
    if (home.currency !== base) throw new LedgerError(`home wallet is ${home.currency}, expected base ${base}`, "CURRENCY_MISMATCH");
    const debit = parseMoney(input.amountBase);
    if (debit <= 0n) throw new LedgerError("amountBase must be positive", "BAD_AMOUNT");
    if (parseMoney(home.balance) < debit) throw new LedgerError("insufficient home balance", "INSUFFICIENT_FUNDS");

    // 3) Load + row-lock the host wallet.
    const [host] = await tx.select().from(wallets).where(eq(wallets.id, input.hostWalletId)).for("update");
    if (!host || host.userId !== input.userId) throw new LedgerError("host wallet not found", "WALLET_NOT_FOUND");
    if (host.currency !== quote) throw new LedgerError(`host wallet is ${host.currency}, expected quote ${quote}`, "CURRENCY_MISMATCH");

    // 4) Exact conversion math on the LOCKED rate: credit = (amountBase − feeFlat) × FX_final.
    const netBase = debit - parseMoney(feeFlat);
    if (netBase <= 0n) throw new LedgerError("fee exceeds or equals conversion amount", "BAD_FEE");
    const hostCreditedScaled = mulScaled(netBase, parseMoney(fxFinal));
    const hostCredited = formatMoney(hostCreditedScaled);
    const baseSysWallet = await resolveSystemWalletId(tx, bind, base);
    const quoteSysWallet = await resolveSystemWalletId(tx, bind, quote);

    // 5) Post the four offsetting legs atomically.
    await applyLegsInTx(tx, bind, transactionId, [
      { walletId: input.homeWalletId, userId: input.userId, currency: base, amount: formatMoney(-debit), kind: "fx.convert", description: "debit home for FX" },
      { walletId: baseSysWallet, userId: SYSTEM_USER_ID, currency: base, amount: input.amountBase, kind: "fx.convert", description: "system receives base" },
      { walletId: input.hostWalletId, userId: input.userId, currency: quote, amount: hostCredited, kind: "fx.convert", description: "credit host at locked rate" },
      { walletId: quoteSysWallet, userId: SYSTEM_USER_ID, currency: quote, amount: formatMoney(-hostCreditedScaled), kind: "fx.convert", description: "system provides quote" },
    ]);

    // 6) Audit under the actor context.
    await bind({ userId: input.userId, role: "student" });
    await appendAuditEvent(tx, {
      action: "fx.convert",
      actorUserId: input.userId,
      actorRole: "student",
      entityType: "ledger_transaction",
      entityId: transactionId,
      details: { base, quote, amountBase: input.amountBase, feeFlat, fxFinal, hostCredited, rateLockId: input.rateLockId },
    });

    // Re-read post-conversion cached balances (owner context).
    await bind({ userId: input.userId, role: "student" });
    const [homeAfter] = await tx.select().from(wallets).where(eq(wallets.id, input.homeWalletId));
    const [hostAfter] = await tx.select().from(wallets).where(eq(wallets.id, input.hostWalletId));

    return {
      transactionId,
      fxFinal,
      feeFlat,
      amountBase: input.amountBase,
      hostCredited,
      homeBalance: homeAfter?.balance ?? home.balance,
      hostBalance: hostAfter?.balance ?? host.balance,
    };
  });
}

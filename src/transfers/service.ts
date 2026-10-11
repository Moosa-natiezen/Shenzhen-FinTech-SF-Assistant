/**
 * Sponsor funding & cross-border transfers (T10).
 *
 *  - Deposits (sponsor tier): mint home-currency funds into a sponsor wallet;
 *    the platform "system" wallet is the offsetting counterparty, so the posting
 *    stays balanced double-entry.
 *  - Transfers (sponsor tier): sponsor -> recipient. Same-currency is a 2-leg
 *    zero-sum posting; cross-currency consumes a live server-side FX lock and
 *    posts the 4-leg balanced conversion, crediting the RECIPIENT's host wallet.
 *  - Sanctions/PEP screening hook with BLOCK-ON-MISS (a screening failure or
 *    unknown outcome blocks the transfer rather than passing it).
 *  - Velocity caps (per-tx / daily / cumulative), DB-backed from the transfers
 *    table — no in-memory state that a restart could clear.
 *  - New-payout-target and large-transfer step-up are enforced at the gateway
 *    (requireFreshAuth); this module exposes `isFirstTransferToRecipient` for it.
 *
 * Everything (caps + screening + legs + transfer row + audit) commits or rolls
 * back in ONE transaction (I-3) with FOR UPDATE row locks.
 */
import { randomUUID } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { transfers, wallets } from "../db/schema";
import { SYSTEM_USER_ID, withContextSwitching } from "../db/rls";
import type { AnyPgDatabase } from "../db/types";
import { appendAuditEvent } from "../security/audit";
import { formatMoney, mulScaled, parseMoney } from "../ledger/money";
import { applyLegsInTx, LedgerError, resolveSystemWalletId, type PostingLeg } from "../ledger/engine";
import { consumeRateLockInTx } from "../fx/service";

/** Velocity caps (absolute source-currency thresholds). Overridable per call. */
export interface CapLimits {
  perTx: string;
  daily: string;
  cumulative: string;
}
export const DEFAULT_CAPS: CapLimits = {
  perTx: "100000",
  daily: "500000",
  cumulative: "2000000",
};

export interface ScreeningOutcome {
  blocked: boolean;
  reason?: string;
}

/**
 * Sanctions/PEP screening seam (design doc §5 "Integrations"). The default stub
 * returns clean; production replaces the body with a real screening-provider
 * call. `screenOrBlock` enforces BLOCK-ON-MISS around it.
 */
export async function screenParty(_targetUserId: string, _amountScaled: bigint): Promise<ScreeningOutcome> {
  return { blocked: false };
}

/**
 * Wraps a screening provider with block-on-miss semantics: a throw or a missing
 * decision BLOCKS the transaction. `screening` is injectable for tests; the
 * default is the production `screenParty` seam.
 */
export async function screenOrBlock(
  targetUserId: string,
  amountScaled: bigint,
  screening: (t: string, a: bigint) => Promise<ScreeningOutcome> = screenParty,
): Promise<ScreeningOutcome> {
  try {
    const result = await screening(targetUserId, amountScaled);
    if (!result || typeof result.blocked !== "boolean") {
      return { blocked: true, reason: "screening returned no decision (block-on-miss)" };
    }
    return result;
  } catch (e) {
    return { blocked: true, reason: `screening unavailable (block-on-miss): ${(e as Error).message}` };
  }
}

/** True when the sender has never transferred to this recipient (new payout target). */
export async function isFirstTransferToRecipient(db: AnyPgDatabase, senderId: string, recipientId: string): Promise<boolean> {
  return withContextSwitching(db, async (tx, bind) => {
    await bind({ userId: senderId, role: "student" });
    const prior = await tx
      .select({ id: transfers.id })
      .from(transfers)
      .where(and(eq(transfers.senderUserId, senderId), eq(transfers.recipientUserId, recipientId)))
      .limit(1);
    return prior.length === 0;
  });
}

interface CapCheck {
  allowed: boolean;
  reason?: string;
}

/** DB-backed velocity-cap enforcement against the sender's transfer history. */
async function checkCaps(tx: any, bind: (ctx: any) => Promise<void>, senderId: string, amountScaled: bigint, caps: CapLimits): Promise<CapCheck> {
  if (amountScaled > parseMoney(caps.perTx)) return { allowed: false, reason: "per-tx cap exceeded" };
  await bind({ userId: senderId, role: "student" });
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const [daily] = await tx
    .select({ total: sql<string>`coalesce(sum(${transfers.amountFrom}), 0)` })
    .from(transfers)
    .where(and(eq(transfers.senderUserId, senderId), gte(transfers.occurredAt, startOfDay)));
  const [cumulative] = await tx
    .select({ total: sql<string>`coalesce(sum(${transfers.amountFrom}), 0)` })
    .from(transfers)
    .where(eq(transfers.senderUserId, senderId));
  const dailySoFar = parseMoney(String(daily?.total ?? "0"));
  const cumulativeSoFar = parseMoney(String(cumulative?.total ?? "0"));
  if (dailySoFar + amountScaled > parseMoney(caps.daily)) return { allowed: false, reason: "daily cap exceeded" };
  if (cumulativeSoFar + amountScaled > parseMoney(caps.cumulative)) return { allowed: false, reason: "cumulative cap exceeded" };
  return { allowed: true };
}

export interface DepositInput {
  sponsorUserId: string;
  walletId: string; // sponsor's wallet to credit
  amount: string; // positive decimal
  caps?: Partial<CapLimits>;
}

export interface FundingResult {
  transactionId: string;
  transferId: string;
  amount: string;
  walletBalance: string;
}

/** Sponsor deposits home-currency funds (system wallet is the counterparty). */
export async function depositFunds(db: AnyPgDatabase, input: DepositInput): Promise<FundingResult> {
  const caps = { ...DEFAULT_CAPS, ...input.caps };
  const amountScaled = parseMoney(input.amount);
  if (amountScaled <= 0n) throw new LedgerError("deposit amount must be positive", "BAD_AMOUNT");
  const transactionId = randomUUID();
  const transferId = randomUUID();

  return withContextSwitching(db, async (tx, bind) => {
    // Verify the wallet is the sponsor's and read its currency (owner context).
    await bind({ userId: input.sponsorUserId, role: "student" });
    const [wallet] = await tx.select().from(wallets).where(eq(wallets.id, input.walletId)).for("update");
    if (!wallet || wallet.userId !== input.sponsorUserId) throw new LedgerError("wallet not found", "WALLET_NOT_FOUND");
    const currency = wallet.currency;

    // Velocity caps (block-on-miss equivalent: caps must pass).
    const capsCheck = await checkCaps(tx, bind, input.sponsorUserId, amountScaled, caps);
    if (!capsCheck.allowed) throw new LedgerError(capsCheck.reason!, "CAP_EXCEEDED");

    // Screening (sponsor's own funding source) — block-on-miss.
    const screened = await screenOrBlock(input.sponsorUserId, amountScaled);
    if (screened.blocked) throw new LedgerError(screened.reason ?? "screening blocked", "SCREENING_BLOCKED");

    const sysWallet = await resolveSystemWalletId(tx, bind, currency);

    await applyLegsInTx(tx, bind, transactionId, [
      { walletId: input.walletId, userId: input.sponsorUserId, currency, amount: formatMoney(amountScaled), kind: "deposit", description: "sponsor deposit" },
      { walletId: sysWallet, userId: SYSTEM_USER_ID, currency, amount: formatMoney(-amountScaled), kind: "deposit", description: "system funding source" },
    ]);

    // transfers_sender_insert requires sender_user_id = app.user_id, so bind the
    // sponsor context (applyLegsInTx left us bound to the last leg's owner).
    await bind({ userId: input.sponsorUserId, role: "student" });
    await tx.insert(transfers).values({
      id: transferId,
      senderUserId: input.sponsorUserId,
      recipientUserId: null,
      fromWalletId: sysWallet,
      toWalletId: input.walletId,
      fromCurrency: currency,
      toCurrency: currency,
      amountFrom: formatMoney(amountScaled),
      amountTo: formatMoney(amountScaled),
      fxFinal: null,
      feeFlat: "0",
      kind: "deposit",
      status: "settled",
      transactionId,
    });

    await bind({ userId: input.sponsorUserId, role: "student" });
    await appendAuditEvent(tx, {
      action: "funding.deposit",
      actorUserId: input.sponsorUserId,
      actorRole: "sponsor",
      entityType: "transfer",
      entityId: transferId,
      details: { amount: input.amount, currency, walletId: input.walletId },
    });

    const [after] = await tx.select().from(wallets).where(eq(wallets.id, input.walletId));
    return { transactionId, transferId, amount: input.amount, walletBalance: after?.balance ?? wallet.balance };
  });
}

export interface TransferInput {
  senderUserId: string;
  recipientUserId: string;
  fromWalletId: string; // sender's wallet (base currency for cross-currency)
  toWalletId: string; // recipient's wallet (quote currency for cross-currency)
  amountFrom: string; // source amount (decimal)
  rateLockId?: string; // required for cross-currency
  feeFlat?: string;
  caps?: Partial<CapLimits>;
}

/** Sponsor -> recipient transfer; cross-currency consumes a live FX lock. */
export async function transferFunds(db: AnyPgDatabase, input: TransferInput): Promise<FundingResult & { fxFinal: string | null; amountTo: string }> {
  const caps = { ...DEFAULT_CAPS, ...input.caps };
  const amountScaled = parseMoney(input.amountFrom);
  if (amountScaled <= 0n) throw new LedgerError("transfer amount must be positive", "BAD_AMOUNT");
  const transactionId = randomUUID();
  const transferId = randomUUID();

  return withContextSwitching(db, async (tx, bind) => {
    // Lock + inspect the sender's and recipient's wallets (owner contexts).
    await bind({ userId: input.senderUserId, role: "student" });
    const [from] = await tx.select().from(wallets).where(eq(wallets.id, input.fromWalletId)).for("update");
    if (!from || from.userId !== input.senderUserId) throw new LedgerError("source wallet not found", "WALLET_NOT_FOUND");
    if (parseMoney(from.balance) < amountScaled) throw new LedgerError("insufficient source balance", "INSUFFICIENT_FUNDS");

    await bind({ userId: input.recipientUserId, role: "student" });
    const [to] = await tx.select().from(wallets).where(eq(wallets.id, input.toWalletId)).for("update");
    if (!to || to.userId !== input.recipientUserId) throw new LedgerError("recipient wallet not found", "WALLET_NOT_FOUND");

    const capsCheck = await checkCaps(tx, bind, input.senderUserId, amountScaled, caps);
    if (!capsCheck.allowed) throw new LedgerError(capsCheck.reason!, "CAP_EXCEEDED");

    const screened = await screenOrBlock(input.recipientUserId, amountScaled);
    if (screened.blocked) throw new LedgerError(screened.reason ?? "screening blocked", "SCREENING_BLOCKED");

    const legs: PostingLeg[] = [];
    let amountTo: string;
    let fxFinal: string | null = null;
    let feeFlat = input.feeFlat ?? "0";

    if (from.currency === to.currency) {
      // Same currency: plain 2-leg zero-sum transfer.
      amountTo = formatMoney(amountScaled);
      feeFlat = "0";
      legs.push(
        { walletId: input.fromWalletId, userId: input.senderUserId, currency: from.currency, amount: formatMoney(-amountScaled), kind: "transfer", description: "debit sender" },
        { walletId: input.toWalletId, userId: input.recipientUserId, currency: to.currency, amount: amountTo, kind: "transfer", description: "credit recipient" },
      );
    } else {
      // Cross-currency: consume a live server-side lock; 4-leg balanced posting.
      if (!input.rateLockId) throw new LedgerError("cross-currency transfer requires a rate lock", "FX_LOCK_REQUIRED");
      const lock = await consumeRateLockInTx(tx, bind, input.rateLockId, {
        userId: input.senderUserId,
        baseCurrency: from.currency,
        quoteCurrency: to.currency,
        amountBase: input.amountFrom,
      });
      fxFinal = lock.fxFinal;
      feeFlat = input.feeFlat ?? lock.feeFlat;
      const netBase = amountScaled - parseMoney(feeFlat);
      if (netBase <= 0n) throw new LedgerError("fee exceeds or equals transfer amount", "BAD_FEE");
      const creditedScaled = mulScaled(netBase, parseMoney(fxFinal));
      amountTo = formatMoney(creditedScaled);
      const baseSys = await resolveSystemWalletId(tx, bind, from.currency);
      const quoteSys = await resolveSystemWalletId(tx, bind, to.currency);
      legs.push(
        { walletId: input.fromWalletId, userId: input.senderUserId, currency: from.currency, amount: formatMoney(-amountScaled), kind: "transfer", description: "debit sender base" },
        { walletId: baseSys, userId: SYSTEM_USER_ID, currency: from.currency, amount: input.amountFrom, kind: "transfer", description: "system receives base" },
        { walletId: input.toWalletId, userId: input.recipientUserId, currency: to.currency, amount: amountTo, kind: "transfer", description: "credit recipient at locked rate" },
        { walletId: quoteSys, userId: SYSTEM_USER_ID, currency: to.currency, amount: formatMoney(-creditedScaled), kind: "transfer", description: "system provides quote" },
      );
    }

    await applyLegsInTx(tx, bind, transactionId, legs);

    // transfers_sender_insert requires sender_user_id = app.user_id; re-bind to
    // the sender (the last leg may belong to the recipient or the system).
    await bind({ userId: input.senderUserId, role: "student" });
    await tx.insert(transfers).values({
      id: transferId,
      senderUserId: input.senderUserId,
      recipientUserId: input.recipientUserId,
      fromWalletId: input.fromWalletId,
      toWalletId: input.toWalletId,
      fromCurrency: from.currency,
      toCurrency: to.currency,
      amountFrom: formatMoney(amountScaled),
      amountTo,
      fxFinal,
      feeFlat,
      kind: "transfer",
      status: "settled",
      transactionId,
    });

    await bind({ userId: input.senderUserId, role: "student" });
    await appendAuditEvent(tx, {
      action: "funding.transfer",
      actorUserId: input.senderUserId,
      actorRole: "sponsor",
      entityType: "transfer",
      entityId: transferId,
      details: { amountFrom: input.amountFrom, amountTo, fxFinal, feeFlat, recipient: input.recipientUserId },
    });

    const [after] = await tx.select().from(wallets).where(eq(wallets.id, input.fromWalletId));
    return { transactionId, transferId, amount: input.amountFrom, amountTo, fxFinal, walletBalance: after?.balance ?? from.balance };
  });
}

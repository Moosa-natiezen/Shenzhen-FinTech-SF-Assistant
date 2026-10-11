/**
 * Double-entry ledger engine (T7) — the ONLY code path that mutates money.
 *
 * Invariants enforced here:
 *  - I-10 exactness: amounts are signed NUMERIC(20,8) carried as scaled BigInt
 *    (money.ts); no IEEE-754 ever touches a value.
 *  - Double-entry: a posting is a set of >= 2 legs sharing a transactionId and
 *    summing to ZERO within every currency (a per-currency balanced book). The
 *    engine REJECTS any posting that does not balance, so an unbalanced entry
 *    cannot be written even by a service bug.
 *  - I-3 atomicity: every leg of a posting commits or rolls back together in a
 *    single Postgres transaction, with `SELECT ... FOR UPDATE` row locks on the
 *    touched wallets so concurrent writers serialize instead of racing.
 *  - I-1 derived state: `wallets.balance` is a cached projection of
 *    SUM(ledger_entries.amount); it is updated inside the same transaction as
 *    the entries so it can never drift (verifyBalances recomputes and asserts).
 *  - I-1 RLS: multi-owner postings (sponsor + system + student) run in ONE
 *    transaction by re-binding app.user_id per leg (rls.ts `withContextSwitching`);
 *    no policy is weakened, every write still runs under its owner's context.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { balanceSnapshots, ledgerEntries, wallets } from "../db/schema";
import { SYSTEM_USER_ID, withContextSwitching, type RlsContext } from "../db/rls";
import type { AnyPgDatabase } from "../db/types";
import { appendAuditEvent, type AuditEvent } from "../security/audit";
import { formatMoney, parseMoney } from "./money";

export class LedgerError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "LedgerError";
  }
}

/** One offsetting leg of a posting. `amount` is a signed 8-decimal string. */
export interface PostingLeg {
  walletId: string;
  userId: string; // wallet owner — determines the bound RLS context
  currency: string; // must match the wallet's currency
  amount: string; // signed decimal: negative = debit, positive = credit
  kind: string; // e.g. "deposit" | "transfer" | "fx.convert"
  description?: string;
}

export interface PostingRequest {
  transactionId?: string; // generated when omitted
  legs: PostingLeg[];
  audit?: AuditEvent; // one summary audit event for the whole posting
}

export interface PostingResult {
  transactionId: string;
  // Post-leg cached balances keyed by walletId (signed 8-decimal strings).
  balances: Record<string, string>;
}

/** Validates >= 2 legs and per-currency zero-sum before touching the DB. */
export function validateLegs(legs: PostingLeg[]): void {
  if (legs.length < 2) {
    throw new LedgerError("double-entry posting requires at least two legs", "UNBALANCED");
  }
  const perCurrency = new Map<string, bigint>();
  for (const leg of legs) {
    let scaled: bigint;
    try {
      scaled = parseMoney(leg.amount);
    } catch {
      throw new LedgerError(`invalid amount ${JSON.stringify(leg.amount)}`, "BAD_AMOUNT");
    }
    if (scaled === 0n) {
      throw new LedgerError("ledger leg amount cannot be zero", "ZERO_LEG");
    }
    perCurrency.set(leg.currency, (perCurrency.get(leg.currency) ?? 0n) + scaled);
  }
  for (const [currency, total] of perCurrency) {
    if (total !== 0n) {
      throw new LedgerError(
        `unbalanced posting: ${currency} legs sum to ${formatMoney(total)}, expected 0`,
        "UNBALANCED",
      );
    }
  }
}

/**
 * Applies the legs inside an ALREADY-OPEN transaction, re-binding the RLS
 * context per leg. Exported so services can compose a posting with extra work
 * (lock consumption, cap checks, transfer rows) in the SAME transaction (I-3).
 *
 * `tx` is a drizzle PG transaction. Each leg: bind owner ctx -> lock wallet
 * FOR UPDATE -> append entry -> update cached balance + snapshot.
 */
export async function applyLegsInTx(
  tx: any,
  bind: (ctx: RlsContext) => Promise<void>,
  transactionId: string,
  legs: PostingLeg[],
): Promise<Record<string, string>> {
  // Deterministic lock order (by walletId) avoids deadlock across concurrent
  // postings that touch overlapping wallets.
  const ordered = [...legs].sort((a, b) => (a.walletId < b.walletId ? -1 : a.walletId > b.walletId ? 1 : 0));
  const balances: Record<string, string> = {};

  for (const leg of ordered) {
    // Owner-scoped RLS context. The role is "student" (least privilege) for
    // every owner — the write policies key only on app.user_id.
    await bind({ userId: leg.userId, role: "student" });

    // Row-lock the wallet under its owner's context (I-3).
    const [wallet] = await tx.select().from(wallets).where(eq(wallets.id, leg.walletId)).for("update");
    if (!wallet) {
      throw new LedgerError(`wallet ${leg.walletId} not found`, "WALLET_NOT_FOUND");
    }
    if (wallet.userId !== leg.userId) {
      throw new LedgerError(`wallet ${leg.walletId} is not owned by ${leg.userId}`, "WALLET_OWNER_MISMATCH");
    }
    if (wallet.currency !== leg.currency) {
      throw new LedgerError(
        `wallet ${leg.walletId} currency ${wallet.currency} != leg currency ${leg.currency}`,
        "CURRENCY_MISMATCH",
      );
    }

    const delta = parseMoney(leg.amount);
    const newBalance = formatMoney(parseMoney(wallet.balance) + delta);

    await tx.insert(ledgerEntries).values({
      id: randomUUID(),
      transactionId,
      walletId: leg.walletId,
      userId: leg.userId,
      currency: leg.currency,
      amount: leg.amount,
      entryType: delta < 0n ? "debit" : "credit",
      kind: leg.kind,
      description: leg.description,
    });
    await tx.update(wallets).set({ balance: newBalance, updatedAt: new Date() }).where(eq(wallets.id, leg.walletId));
    await tx.insert(balanceSnapshots).values({
      id: randomUUID(),
      walletId: leg.walletId,
      userId: leg.userId,
      currency: leg.currency,
      balance: newBalance,
    });

    balances[leg.walletId] = newBalance;
  }
  return balances;
}

/**
 * Posts a self-contained posting (legs + optional audit) atomically. For simple
 * cases; services that need extra same-transaction work call applyLegsInTx
 * directly inside their own withContextSwitching block.
 */
export async function postLedgerTransaction(db: AnyPgDatabase, req: PostingRequest): Promise<PostingResult> {
  validateLegs(req.legs);
  const transactionId = req.transactionId ?? randomUUID();
  return withContextSwitching(db, async (tx, bind) => {
    const balances = await applyLegsInTx(tx, bind, transactionId, req.legs);
    if (req.audit) {
      // Audit is appended under the actor's own context.
      await bind({ userId: req.audit.actorUserId ?? SYSTEM_USER_ID, role: "student" });
      await appendAuditEvent(tx, {
        ...req.audit,
        entityType: req.audit.entityType ?? "ledger_transaction",
        entityId: req.audit.entityId ?? transactionId,
        details: { ...(req.audit.details ?? {}), transactionId },
      });
    }
    return { transactionId, balances };
  });
}

/**
 * Recomputes a wallet's true balance as SUM(ledger_entries.amount) under the
 * owner's RLS context. Used by tests to prove the cached `wallets.balance`
 * never drifts from the append-only source of truth (I-1).
 */
export async function deriveBalance(db: AnyPgDatabase, walletId: string, ownerUserId: string): Promise<string> {
  return withContextSwitching(db, async (tx, bind) => {
    await bind({ userId: ownerUserId, role: "student" });
    const [row] = await tx
      .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, walletId));
    return formatMoney(parseMoney(String(row?.total ?? "0")));
  });
}

/**
 * Resolves the platform "system" clearing wallet for a currency (the counterparty
 * that absorbs deposits and FX) under the system RLS context, inside an open tx.
 * Seeded by migration 0003 (sys-wallet-<ccy>); looked up by owner+currency so it
 * does not depend on the exact id.
 */
export async function resolveSystemWalletId(tx: any, bind: (ctx: RlsContext) => Promise<void>, currency: string): Promise<string> {
  const ccy = currency.toUpperCase();
  await bind({ userId: SYSTEM_USER_ID, role: "student" });
  const all = await tx.select({ id: wallets.id, currency: wallets.currency }).from(wallets).where(eq(wallets.userId, SYSTEM_USER_ID));
  const match = all.find((w: { currency: string }) => w.currency === ccy);
  if (!match) throw new LedgerError(`no system wallet for ${ccy}`, "SYSTEM_WALLET_MISSING");
  return match.id;
}

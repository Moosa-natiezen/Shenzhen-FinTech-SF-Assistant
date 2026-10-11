/**
 * University directory + tuition payment routing (T11).
 *
 *  - Verified-institution registry: only `verified` institutions can be paid.
 *  - Student-tier payment routing: the STUDENT initiates a payment from their
 *    host-currency wallet; the platform's system clearing wallet is the
 *    counterparty (funds are settled to institutions in batch). The posting is a
 *    balanced double-entry (I-3, I-10) via the Phase-2 ledger engine with a
 *    FOR UPDATE row lock on the wallet.
 *  - Immutable compliance receipts: each payment appends a `tuition_payments`
 *    row sealed with a `receipt_hash` (append-only, tamper-evident) (I-6).
 *  - Sponsors get READ-ONLY receipt access via `sponsor_links` (RLS-scoped).
 *  - A settled payment triggers an R_score recompute (T12).
 */
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { sponsorLinks, tuitionPayments, universities, wallets } from "../db/schema";
import { SYSTEM_USER_ID, withContextSwitching } from "../db/rls";
import type { AnyPgDatabase } from "../db/types";
import { appendAuditEvent } from "../security/audit";
import { applyLegsInTx, resolveSystemWalletId, type PostingLeg } from "../ledger/engine";
import { formatMoney, parseMoney } from "../ledger/money";
import { recomputeOnPayment } from "../credit/rscore";

export class TuitionError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "TuitionError";
  }
}

export interface University {
  id: string;
  name: string;
  country: string;
  currency: string;
  verified: boolean;
}

/** Lists verified institutions (safe columns only; settlement SPII never here). */
export async function listUniversities(db: AnyPgDatabase): Promise<University[]> {
  return withContextSwitching(db, async (tx, bind) => {
    await bind({ userId: SYSTEM_USER_ID, role: "student" }); // any bound context reads the directory
    const rows = await tx
      .select({ id: universities.id, name: universities.name, country: universities.country, currency: universities.currency, verified: universities.verified })
      .from(universities);
    return rows.filter((r) => r.verified);
  });
}

/** Canonical receipt payload -> sha256 integrity seal. */
function receiptHash(parts: {
  id: string;
  studentUserId: string;
  universityId: string;
  walletId: string;
  currency: string;
  amount: string;
  transactionId: string;
  status: string;
}): string {
  const canonical = [
    parts.id,
    parts.studentUserId,
    parts.universityId,
    parts.walletId,
    parts.currency,
    parts.amount,
    parts.transactionId,
    parts.status,
  ].join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface PayTuitionInput {
  studentUserId: string;
  universityId: string;
  walletId: string; // the student's host-currency wallet to debit
  amount: string; // positive decimal string
}

export interface Receipt {
  id: string;
  transactionId: string;
  universityId: string;
  currency: string;
  amount: string;
  status: string;
  receiptHash: string;
  newScore?: number;
}

/** Student initiates a tuition payment to a verified institution. */
export async function payTuition(db: AnyPgDatabase, input: PayTuitionInput): Promise<Receipt> {
  const amountScaled = parseMoney(input.amount);
  if (amountScaled <= 0n) throw new TuitionError("tuition amount must be positive", "BAD_AMOUNT");
  const transactionId = randomUUID();
  const paymentId = randomUUID();

  const receipt = await withContextSwitching(db, async (tx, bind) => {
    // Lock + verify the student's wallet (owner context).
    await bind({ userId: input.studentUserId, role: "student" });
    const [wallet] = await tx.select().from(wallets).where(eq(wallets.id, input.walletId)).for("update");
    if (!wallet || wallet.userId !== input.studentUserId) throw new TuitionError("wallet not found", "WALLET_NOT_FOUND");
    if (parseMoney(wallet.balance) < amountScaled) throw new TuitionError("insufficient wallet balance", "INSUFFICIENT_FUNDS");

    // Verify the destination institution is verified and bills in this currency.
    const [uni] = await tx.select().from(universities).where(eq(universities.id, input.universityId));
    if (!uni) throw new TuitionError("university not found", "UNIVERSITY_NOT_FOUND");
    if (!uni.verified) throw new TuitionError("institution is not verified", "INSTITUTION_NOT_VERIFIED");
    if (uni.currency !== wallet.currency) throw new TuitionError(`institution bills in ${uni.currency}, not ${wallet.currency}`, "CURRENCY_MISMATCH");

    const sysWallet = await resolveSystemWalletId(tx, bind, wallet.currency);
    const legs: PostingLeg[] = [
      { walletId: input.walletId, userId: input.studentUserId, currency: wallet.currency, amount: formatMoney(-amountScaled), kind: "tuition", description: "tuition debit" },
      { walletId: sysWallet, userId: SYSTEM_USER_ID, currency: wallet.currency, amount: input.amount, kind: "tuition", description: "institution clearing" },
    ];
    await applyLegsInTx(tx, bind, transactionId, legs);

    const id = paymentId;
    const status = "settled";
    const hash = receiptHash({
      id,
      studentUserId: input.studentUserId,
      universityId: input.universityId,
      walletId: input.walletId,
      currency: wallet.currency,
      amount: formatMoney(amountScaled),
      transactionId,
      status,
    });

    // Insert the immutable receipt (as the owning student).
    await bind({ userId: input.studentUserId, role: "student" });
    await tx.insert(tuitionPayments).values({
      id,
      transactionId,
      studentUserId: input.studentUserId,
      universityId: input.universityId,
      walletId: input.walletId,
      currency: wallet.currency,
      amount: formatMoney(amountScaled),
      status,
      receiptHash: hash,
    });

    await appendAuditEvent(tx, {
      action: "tuition.pay",
      actorUserId: input.studentUserId,
      actorRole: "student",
      entityType: "tuition_payment",
      entityId: id,
      details: { universityId: input.universityId, amount: formatMoney(amountScaled), currency: wallet.currency, transactionId },
    });

    return { id, transactionId, universityId: input.universityId, currency: wallet.currency, amount: formatMoney(amountScaled), status, receiptHash: hash };
  });

  // A settled payment advances the R_score (T12); a failure here must not roll
  // back the already-committed payment, so it runs after commit.
  try {
    const { score } = await recomputeOnPayment(db, input.studentUserId);
    return { ...receipt, newScore: score };
  } catch {
    return receipt;
  }
}

export interface ReceiptRow {
  id: string;
  universityId: string;
  currency: string;
  amount: string;
  status: string;
  receiptHash: string;
  createdAt: Date;
  studentUserId: string;
}

/**
 * Lists receipts visible under the caller's RLS context: a student sees their
 * own; a sponsor sees linked students' (via the sponsor_links EXISTS policy);
 * compliance sees all. Read-only.
 */
export async function listReceipts(db: AnyPgDatabase, viewer: { userId: string; role: "student" | "sponsor" | "compliance_admin" }): Promise<ReceiptRow[]> {
  return withContextSwitching(db, async (tx, bind) => {
    await bind({ userId: viewer.userId, role: viewer.role });
    const rows = await tx
      .select({
        id: tuitionPayments.id,
        universityId: tuitionPayments.universityId,
        currency: tuitionPayments.currency,
        amount: tuitionPayments.amount,
        status: tuitionPayments.status,
        receiptHash: tuitionPayments.receiptHash,
        createdAt: tuitionPayments.createdAt,
        studentUserId: tuitionPayments.studentUserId,
      })
      .from(tuitionPayments);
    return rows;
  });
}

/** Creates a sponsor->student link (sponsor tier; used by tests and T17). */
export async function createSponsorLink(db: AnyPgDatabase, sponsorUserId: string, studentUserId: string): Promise<void> {
  await withContextSwitching(db, async (tx, bind) => {
    await bind({ userId: sponsorUserId, role: "sponsor" });
    await tx.insert(sponsorLinks).values({
      id: randomUUID(),
      sponsorUserId,
      studentUserId,
    });
  });
}

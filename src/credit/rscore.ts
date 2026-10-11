/**
 * R_score engine (T12) — the internal reliability metric (design doc §2.2).
 *
 *   R_score = 300 + 550 × (0.40·T_tuition + 0.25·B_bills + 0.15·S_wallet + 0.20·L_repay)
 *   clamped to [300, 850].
 *
 * Exactness: the weighted sum is computed with scaled BigInt (no floats), then
 * rounded half-up to an integer and clamped — so a full set of 1.0 components
 * yields exactly 850 and empty components exactly 300 (I-10 spirit).
 *
 * History is APPEND-ONLY: every recompute writes a new `r_score_snapshots` row
 * (triggers forbid UPDATE/DELETE) scoped by RLS to the owning student (I-1, I-6).
 */
import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { rScoreSnapshots, tuitionPayments, wallets } from "../db/schema";
import { withContextSwitching } from "../db/rls";
import type { AnyPgDatabase } from "../db/types";
import { appendAuditEvent } from "../security/audit";

export const R_BASE = 300;
export const BETA = 550;
export const R_MIN = 300;
export const R_MAX = 850;
// Weights (design doc): w1 tuition .40, w2 bills .25, w3 wallet .15, w4 repay .20.
const W = { tuition: 400000n, bills: 250000n, wallet: 150000n, repay: 200000n }; // scale 1e6
const SCALE = 1000000n;

export interface RComponents {
  tTuition: number | string; // [0,1] tuition timeliness
  bBills: number | string; // [0,1] recurring-bill ratio
  sWallet: number | string; // [0,1] wallet-balance stability
  lRepay: number | string; // [0,1] micro-credit repayment cadence
}

/** Clamps a component to [0,1] and converts to a scaled BigInt (1e6). */
function toScaled01(value: number | string, name: string): bigint {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) throw new Error(`invalid R_score component ${name}`);
  const clamped = Math.min(1, Math.max(0, n));
  return BigInt(Math.round(clamped * 1e6));
}

/** Exact R_score = clamp(round(300 + 550·Σ wᵢ·xᵢ)), computed without floats. */
export function computeRScore(c: RComponents): number {
  const t = toScaled01(c.tTuition, "tTuition");
  const b = toScaled01(c.bBills, "bBills");
  const s = toScaled01(c.sWallet, "sWallet");
  const l = toScaled01(c.lRepay, "lRepay");
  // numerator is scale 1e12 (= 550 · Σ wᵢ·xᵢ where w,x are scale 1e6).
  const weighted = W.tuition * t + W.bills * b + W.wallet * s + W.repay * l;
  const numerator = BigInt(BETA) * weighted; // scale 1e12
  const baseScaled = BigInt(R_BASE) * SCALE * SCALE; // 300 at scale 1e12
  // Round half-up to an integer, then clamp.
  const half = (SCALE * SCALE) / 2n;
  let score = Number((baseScaled + numerator + half) / (SCALE * SCALE));
  return Math.min(R_MAX, Math.max(R_MIN, score));
}

export interface RecordScoreInput {
  studentUserId: string;
  components: RComponents;
  triggerEvent: string;
}

/** Appends one R_score snapshot (append-only) + audit, atomically. */
export async function recordScore(db: AnyPgDatabase, input: RecordScoreInput): Promise<{ score: number }> {
  const score = computeRScore(input.components);
  const id = randomUUID();
  await withContextSwitching(db, async (tx, bind) => {
    await bind({ userId: input.studentUserId, role: "student" });
    await tx.insert(rScoreSnapshots).values({
      id,
      studentUserId: input.studentUserId,
      score,
      tTuition: String(input.components.tTuition),
      bBills: String(input.components.bBills),
      sWallet: String(input.components.sWallet),
      lRepay: String(input.components.lRepay),
      triggerEvent: input.triggerEvent,
    });
    await appendAuditEvent(tx, {
      action: "credit.rscore.record",
      actorUserId: input.studentUserId,
      actorRole: "student",
      entityType: "r_score_snapshot",
      entityId: id,
      details: { score, ...input.components, triggerEvent: input.triggerEvent },
    });
  });
  return { score };
}

/**
 * Derives the [0,1] sub-scores from on-platform behaviour. B_bills and L_repay
 * await the Phase-4 bills / micro-credit pipelines and are conservative 0 here.
 */
export async function deriveComponents(db: AnyPgDatabase, studentUserId: string): Promise<RComponents> {
  return withContextSwitching(db, async (tx, bind) => {
    await bind({ userId: studentUserId, role: "student" });
    // T_tuition: settled tuition payments, a term of 4 on-time payments => 1.0.
    const [paid] = await tx
      .select({ n: sql<string>`count(*) filter (where ${tuitionPayments.status} = 'settled')` })
      .from(tuitionPayments)
      .where(eq(tuitionPayments.studentUserId, studentUserId));
    const settled = Number(paid?.n ?? 0);
    const tTuition = Math.min(1, settled / 4);
    // S_wallet: total held balance vs a stability target of 2000 => [0,1].
    const [sum] = await tx
      .select({ total: sql<string>`coalesce(sum(${wallets.balance}), 0)` })
      .from(wallets)
      .where(eq(wallets.userId, studentUserId));
    const total = Number(sum?.total ?? 0);
    const sWallet = Math.min(1, total / 2000);
    return { tTuition, bBills: 0, sWallet, lRepay: 0 };
  });
}

/** Recomputes and records a student's score after a payment event. */
export async function recomputeOnPayment(db: AnyPgDatabase, studentUserId: string): Promise<{ score: number }> {
  const components = await deriveComponents(db, studentUserId);
  return recordScore(db, { studentUserId, components, triggerEvent: "tuition.settled" });
}

/** Returns the student's latest score (RLS-scoped to the owner). */
export async function getLatestScore(db: AnyPgDatabase, studentUserId: string): Promise<{ score: number; computedAt: Date } | null> {
  return withContextSwitching(db, async (tx, bind) => {
    await bind({ userId: studentUserId, role: "student" });
    const [row] = await tx
      .select()
      .from(rScoreSnapshots)
      .where(eq(rScoreSnapshots.studentUserId, studentUserId))
      .orderBy(desc(rScoreSnapshots.computedAt))
      .limit(1);
    return row ? { score: row.score, computedAt: row.computedAt } : null;
  });
}

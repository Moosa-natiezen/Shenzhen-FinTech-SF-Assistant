/**
 * Flagged / high-risk transaction review (T19 / Access Control Matrix:
 * Compliance & Admin "inspect flagged or high-risk transactions").
 *
 * A transaction is FLAGGED when any of:
 *  - it was BLOCKED by sanctions/PEP screening (status="blocked"), or
 *  - its source amount is at/above the large-transfer review threshold, or
 *  - it was the subject of a velocity-cap alert (structuring signal).
 *
 * Reads run as the compliance RLS context (transfers RLS grants the
 * compliance_admin role SELECT); a student/sponsor session can never reach
 * this path (gateway RBAC denies before the query).
 */
import { desc, gte, or, sql } from "drizzle-orm";
import { transfers } from "../db/schema";
import { withUserContext } from "../db/rls";
import type { AnyPgDatabase } from "../db/types";

/** Large-transfer review threshold (source currency units). */
export const FLAG_THRESHOLD = "1000";

export interface FlaggedRow {
  id: string;
  occurredAt: Date;
  senderUserId: string;
  recipientUserId: string | null;
  fromCurrency: string;
  toCurrency: string;
  amountFrom: string;
  kind: string;
  status: string;
  screeningReason: string | null;
  flags: string[];
}

export async function listFlagged(
  db: AnyPgDatabase,
  actor: { userId: string },
  limit = 100,
): Promise<FlaggedRow[]> {
  const rows = await withUserContext(
    db,
    { userId: actor.userId, role: "compliance_admin" },
    (tx) =>
      tx
        .select()
        .from(transfers)
        .where(
          or(
            sql`${transfers.status} = 'blocked'`,
            sql`${transfers.screeningReason} IS NOT NULL`,
            gte(transfers.amountFrom, FLAG_THRESHOLD),
          ),
        )
        .orderBy(desc(transfers.occurredAt))
        .limit(limit),
  );
  return rows.map((r) => ({
    id: r.id,
    occurredAt: r.occurredAt,
    senderUserId: r.senderUserId,
    recipientUserId: r.recipientUserId,
    fromCurrency: r.fromCurrency,
    toCurrency: r.toCurrency,
    amountFrom: String(r.amountFrom),
    kind: r.kind,
    status: r.status,
    screeningReason: r.screeningReason,
    flags: [
      ...(r.status === "blocked" ? (["screening_block"] as const) : []),
      ...(r.screeningReason ? (["screening_reason"] as const) : []),
      ...(Number(r.amountFrom) >= Number(FLAG_THRESHOLD) ? (["large_transfer"] as const) : []),
    ],
  }));
}

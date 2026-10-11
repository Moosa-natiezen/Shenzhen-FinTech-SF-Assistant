/**
 * Metro 2 reporting pipeline (T13) — compliance-admin-only (design doc §2.2
 * "Bureau Reporting Pipeline", Security §2 Risk 6).
 *
 *  - Formatter: builds a Metro-2-style base-segment record per student account
 *    from tuition history + the latest R_score.
 *  - EXPORT ENCLAVE: the student's SPII (national ID / passport) is AES-256-GCM
 *    ciphertext at rest. It is decrypted ONLY inside `runExportEnclave` to derive
 *    a stable tokenized account reference; the plaintext is never placed in the
 *    returned records. A runtime scrub asserts the plaintext does not appear in
 *    the serialized output and throws otherwise (defense-in-depth) (I-5).
 *  - Every export is audited (I-6). Keys come from the KMS-injected keyring.
 */
import { createHash, randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { creditProfiles, rScoreSnapshots, tuitionPayments } from "../db/schema";
import { withContextSwitching } from "../db/rls";
import type { AnyPgDatabase } from "../db/types";
import { appendAuditEvent } from "../security/audit";
import { decryptSpii, type SpiiKeyring } from "../security/spii";
import { formatMoney, parseMoney } from "../ledger/money";

export interface Metro2Record {
  segmentType: "B";
  // Tokenized (sha256) account reference — NEVER the plaintext SPII.
  accountNumber: string;
  portfolioType: string;
  accountType: string;
  paymentRating: string; // derived from R_score
  originalBalance: string;
  currentBalance: string;
  dateOpened: string | null;
  rscore: number;
}

export interface Metro2Export {
  exportId: string;
  generatedAt: string;
  records: Metro2Record[];
  checksum: string;
}

/** Maps an R_score onto a Metro-2 payment rating bucket (1 = best). */
function paymentRating(score: number): string {
  if (score >= 740) return "1";
  if (score >= 640) return "2";
  if (score >= 540) return "3";
  if (score >= 440) return "4";
  return "5";
}

/**
 * The trusted EXPORT ENCLAVE. Given the student's decrypted SPII, derive a
 * one-way token and guarantee the plaintext never escapes this boundary.
 */
function runExportEnclave(studentUserId: string, plaintextSpii: string | null, facts: { totalPaid: string; latestScore: number; dateOpened: string | null }): Metro2Record {
  const tokenSource = plaintextSpii ?? `user:${studentUserId}`;
  const accountNumber = createHash("sha256").update(tokenSource, "utf8").digest("hex").slice(0, 16);
  const record: Metro2Record = {
    segmentType: "B",
    accountNumber,
    portfolioType: "DD", // detail debt
    accountType: "I", // installment / tuition
    paymentRating: paymentRating(facts.latestScore),
    originalBalance: facts.totalPaid,
    currentBalance: "0.00000000",
    dateOpened: facts.dateOpened,
    rscore: facts.latestScore,
  };
  // Defense-in-depth: the plaintext must never be present in the record.
  if (plaintextSpii && JSON.stringify(record).includes(plaintextSpii)) {
    throw new Error("SPII LEAK: plaintext appeared inside the export enclave output");
  }
  return record;
}

/**
 * Generates a Metro-2 export for one student. Caller must be a compliance admin
 * (enforced at the gateway + MFA); RLS lets the compliance context read across
 * owners. Decrypts SPII only inside the enclave; output has no plaintext SPII.
 */
export async function generateMetro2Export(
  db: AnyPgDatabase,
  ring: SpiiKeyring,
  input: { studentUserId: string; actorUserId: string },
): Promise<Metro2Export> {
  return withContextSwitching(db, async (tx, bind) => {
    // Compliance context: cross-owner read of payments, score, and SPII profile.
    await bind({ userId: input.actorUserId, role: "compliance_admin" });

    const payments = await tx
      .select()
      .from(tuitionPayments)
      .where(eq(tuitionPayments.studentUserId, input.studentUserId))
      .orderBy(asc(tuitionPayments.createdAt));
    const totalPaid = formatMoney(payments.reduce((acc, p) => acc + parseMoney(String(p.amount)), 0n));
    const dateOpened = payments[0] ? new Date(payments[0].createdAt).toISOString().slice(0, 10) : null;

    const [scoreRow] = await tx
      .select()
      .from(rScoreSnapshots)
      .where(eq(rScoreSnapshots.studentUserId, input.studentUserId))
      .orderBy(asc(rScoreSnapshots.computedAt))
      .limit(1);
    const latestScore = scoreRow?.score ?? 300;

    // Read the encrypted SPII, then decrypt ONLY inside the enclave below.
    const [profile] = await tx.select().from(creditProfiles).where(eq(creditProfiles.studentUserId, input.studentUserId));
    const plaintext = profile?.nationalIdSpii ? decryptSpii(profile.nationalIdSpii, ring, { column: "credit_profiles.national_id_spii", owner: input.studentUserId }) : null;

    const record = runExportEnclave(input.studentUserId, plaintext, { totalPaid, latestScore, dateOpened });

    // Final serialized scrub (defense-in-depth) before anything leaves.
    const serialized = JSON.stringify(record);
    if (plaintext && serialized.includes(plaintext)) {
      throw new Error("SPII LEAK: plaintext present in serialized export");
    }

    const exportId = randomUUID();
    const records = [record];
    const checksum = createHash("sha256").update(JSON.stringify(records), "utf8").digest("hex");

    await appendAuditEvent(tx, {
      action: "metro2.export",
      actorUserId: input.actorUserId,
      actorRole: "compliance_admin",
      entityType: "metro2_export",
      entityId: exportId,
      details: { studentUserId: input.studentUserId, recordCount: records.length, checksum },
    });

    return { exportId, generatedAt: new Date().toISOString(), records, checksum };
  });
}

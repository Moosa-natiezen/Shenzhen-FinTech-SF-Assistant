/* Phase-3 security layer (T11-T13).
 *
 * Seeds run BEFORE the policies exist so the (superuser) migration role can
 * insert them; afterwards FORCE RLS binds everyone, exactly like wallets.
 *
 * universities      : directory readable by any bound context (reference data);
 *                     the settlement SPII column is ciphertext and is only
 *                     surfaced to compliance via the Metro-2 export enclave.
 * sponsor_links     : a sponsor may read their own links (student sees theirs);
 *                     INSERT only as the sponsor being linked.
 * tuition_payments  : immutable receipts — owner student OR linked sponsor
 *                     (EXISTS on sponsor_links) OR compliance may SELECT;
 *                     INSERT only as the owning student; append-only triggers.
 * credit_profiles   : owner/compliance SELECT; owner INSERT (SPII stays ciphertext).
 * r_score_snapshots : owner/compliance SELECT; append-only score history.
 */
INSERT INTO "universities" ("id", "name", "country", "currency", "verified") VALUES
  ('uni-shenzhen-univ', 'Shenzhen University', 'CN', 'CNY', true),
  ('uni-ucl', 'University College London', 'GB', 'GBP', true),
  ('uni-manchester', 'University of Manchester', 'GB', 'GBP', true),
  ('uni-unverified-test', 'Unverified Test College', 'GB', 'GBP', false);
--> statement-breakpoint
ALTER TABLE "universities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "universities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "universities_authenticated_select" ON "universities" FOR SELECT USING (current_setting('app.user_id', true) IS NOT NULL OR current_setting('app.user_role', true) = 'compliance_admin');
--> statement-breakpoint
ALTER TABLE "sponsor_links" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sponsor_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "sponsor_links_party_select" ON "sponsor_links" FOR SELECT USING ("sponsor_user_id" = current_setting('app.user_id', true) OR "student_user_id" = current_setting('app.user_id', true) OR current_setting('app.user_role', true) = 'compliance_admin');
--> statement-breakpoint
CREATE POLICY "sponsor_links_sponsor_insert" ON "sponsor_links" FOR INSERT WITH CHECK ("sponsor_user_id" = current_setting('app.user_id', true));
--> statement-breakpoint
ALTER TABLE "tuition_payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tuition_payments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tuition_payments_read_scoped" ON "tuition_payments" FOR SELECT USING ("student_user_id" = current_setting('app.user_id', true) OR current_setting('app.user_role', true) = 'compliance_admin' OR EXISTS (SELECT 1 FROM "sponsor_links" sl WHERE sl."sponsor_user_id" = current_setting('app.user_id', true) AND sl."student_user_id" = "tuition_payments"."student_user_id"));
--> statement-breakpoint
CREATE POLICY "tuition_payments_student_insert" ON "tuition_payments" FOR INSERT WITH CHECK ("student_user_id" = current_setting('app.user_id', true));
--> statement-breakpoint
ALTER TABLE "credit_profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "credit_profiles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "credit_profiles_owner_select" ON "credit_profiles" FOR SELECT USING ("student_user_id" = current_setting('app.user_id', true) OR current_setting('app.user_role', true) = 'compliance_admin');
--> statement-breakpoint
CREATE POLICY "credit_profiles_owner_insert" ON "credit_profiles" FOR INSERT WITH CHECK ("student_user_id" = current_setting('app.user_id', true));
--> statement-breakpoint
ALTER TABLE "r_score_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "r_score_snapshots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "r_score_snapshots_owner_select" ON "r_score_snapshots" FOR SELECT USING ("student_user_id" = current_setting('app.user_id', true) OR current_setting('app.user_role', true) = 'compliance_admin');
--> statement-breakpoint
CREATE POLICY "r_score_snapshots_owner_insert" ON "r_score_snapshots" FOR INSERT WITH CHECK ("student_user_id" = current_setting('app.user_id', true));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION append_only_forbid() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER tuition_payments_no_update BEFORE UPDATE ON "tuition_payments" FOR EACH ROW EXECUTE FUNCTION append_only_forbid();
--> statement-breakpoint
CREATE TRIGGER tuition_payments_no_delete BEFORE DELETE ON "tuition_payments" FOR EACH ROW EXECUTE FUNCTION append_only_forbid();
--> statement-breakpoint
CREATE TRIGGER tuition_payments_no_truncate BEFORE TRUNCATE ON "tuition_payments" FOR EACH STATEMENT EXECUTE FUNCTION append_only_forbid();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "tuition_payments" FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER r_score_snapshots_no_update BEFORE UPDATE ON "r_score_snapshots" FOR EACH ROW EXECUTE FUNCTION append_only_forbid();
--> statement-breakpoint
CREATE TRIGGER r_score_snapshots_no_delete BEFORE DELETE ON "r_score_snapshots" FOR EACH ROW EXECUTE FUNCTION append_only_forbid();
--> statement-breakpoint
CREATE TRIGGER r_score_snapshots_no_truncate BEFORE TRUNCATE ON "r_score_snapshots" FOR EACH STATEMENT EXECUTE FUNCTION append_only_forbid();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "r_score_snapshots" FROM PUBLIC;
--> statement-breakpoint
CREATE INDEX "tuition_payments_student_user_id_idx" ON "tuition_payments" ("student_user_id");
--> statement-breakpoint
CREATE INDEX "tuition_payments_university_id_idx" ON "tuition_payments" ("university_id");
--> statement-breakpoint
CREATE INDEX "tuition_payments_transaction_id_idx" ON "tuition_payments" ("transaction_id");
--> statement-breakpoint
CREATE INDEX "r_score_snapshots_student_user_id_idx" ON "r_score_snapshots" ("student_user_id");
--> statement-breakpoint
CREATE INDEX "sponsor_links_student_user_id_idx" ON "sponsor_links" ("student_user_id");

/* Phase-2 security layer (T7–T10).
 *
 * Double-entry counterparty accounts: every deposit and fee needs an offsetting
 * leg, so a platform "system" user owns one wallet per supported currency.
 * Seeds run BEFORE the policies exist so a non-superuser migration role (the
 * table owner) can insert them; afterwards FORCE RLS binds everyone, including
 * the owner, exactly like wallets.
 *
 * ledger_entries / balance_snapshots
 *   - FORCE RLS scoped to app.user_id (owner) or compliance_admin reads (I-1).
 *   - Append-only: UPDATE/DELETE/TRUNCATE raise from triggers that bind even
 *     the table owner, plus REVOKEs (I-6) — same shape as audit_log.
 * rate_locks
 *   - FORCE RLS: owner may read/insert; UPDATE only to mark consumption;
 *     no DELETE policy (locks expire in place; every lock is in audit_log).
 * transfers
 *   - FORCE RLS: sender, recipient, or compliance_admin may read; INSERT only
 *     as the sender; rows immutable after insert (status is set at insert).
 */
INSERT INTO "user" ("id", "name", "email", "email_verified", "role") VALUES ('system', 'System', 'system@internal.local', true, 'system');
--> statement-breakpoint
INSERT INTO "wallets" ("id", "user_id", "currency", "kind", "balance") VALUES
  ('sys-wallet-cny', 'system', 'CNY', 'system', '0'),
  ('sys-wallet-gbp', 'system', 'GBP', 'system', '0'),
  ('sys-wallet-usd', 'system', 'USD', 'system', '0');
--> statement-breakpoint
ALTER TABLE "ledger_entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ledger_entries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ledger_entries_owner_select" ON "ledger_entries" FOR SELECT USING ("user_id" = current_setting('app.user_id', true) OR current_setting('app.user_role', true) = 'compliance_admin');
--> statement-breakpoint
CREATE POLICY "ledger_entries_owner_insert" ON "ledger_entries" FOR INSERT WITH CHECK ("user_id" = current_setting('app.user_id', true));
--> statement-breakpoint
ALTER TABLE "balance_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "balance_snapshots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "balance_snapshots_owner_select" ON "balance_snapshots" FOR SELECT USING ("user_id" = current_setting('app.user_id', true) OR current_setting('app.user_role', true) = 'compliance_admin');
--> statement-breakpoint
CREATE POLICY "balance_snapshots_owner_insert" ON "balance_snapshots" FOR INSERT WITH CHECK ("user_id" = current_setting('app.user_id', true));
--> statement-breakpoint
ALTER TABLE "rate_locks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "rate_locks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "rate_locks_owner_select" ON "rate_locks" FOR SELECT USING ("user_id" = current_setting('app.user_id', true) OR current_setting('app.user_role', true) = 'compliance_admin');
--> statement-breakpoint
CREATE POLICY "rate_locks_owner_insert" ON "rate_locks" FOR INSERT WITH CHECK ("user_id" = current_setting('app.user_id', true));
--> statement-breakpoint
CREATE POLICY "rate_locks_owner_update" ON "rate_locks" FOR UPDATE USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));
--> statement-breakpoint
ALTER TABLE "transfers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "transfers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "transfers_party_select" ON "transfers" FOR SELECT USING ("sender_user_id" = current_setting('app.user_id', true) OR "recipient_user_id" = current_setting('app.user_id', true) OR current_setting('app.user_role', true) = 'compliance_admin');
--> statement-breakpoint
CREATE POLICY "transfers_sender_insert" ON "transfers" FOR INSERT WITH CHECK ("sender_user_id" = current_setting('app.user_id', true));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ledger_entries_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE ON "ledger_entries" FOR EACH ROW EXECUTE FUNCTION ledger_entries_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON "ledger_entries" FOR EACH ROW EXECUTE FUNCTION ledger_entries_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON "ledger_entries" FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_forbid_mutation();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "ledger_entries" FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION balance_snapshots_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'balance_snapshots is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER balance_snapshots_no_update BEFORE UPDATE ON "balance_snapshots" FOR EACH ROW EXECUTE FUNCTION balance_snapshots_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER balance_snapshots_no_delete BEFORE DELETE ON "balance_snapshots" FOR EACH ROW EXECUTE FUNCTION balance_snapshots_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER balance_snapshots_no_truncate BEFORE TRUNCATE ON "balance_snapshots" FOR EACH STATEMENT EXECUTE FUNCTION balance_snapshots_forbid_mutation();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "balance_snapshots" FROM PUBLIC;
--> statement-breakpoint
CREATE INDEX "ledger_entries_wallet_id_idx" ON "ledger_entries" ("wallet_id");
--> statement-breakpoint
CREATE INDEX "ledger_entries_user_id_idx" ON "ledger_entries" ("user_id");
--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries" ("transaction_id");
--> statement-breakpoint
CREATE INDEX "transfers_sender_user_id_idx" ON "transfers" ("sender_user_id");
--> statement-breakpoint
CREATE INDEX "transfers_recipient_user_id_idx" ON "transfers" ("recipient_user_id");
--> statement-breakpoint
CREATE INDEX "rate_locks_user_id_idx" ON "rate_locks" ("user_id");

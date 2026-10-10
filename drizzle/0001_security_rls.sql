/* Security layer (design doc §1 "RBAC ... combined with PostgreSQL Row-Level
 * Security", §3.2 auditability, Security Assessment §1 access matrix).
 *
 * 1. Application tables use FORCE ROW LEVEL SECURITY: the application connects
 *    as the table owner, and FORCE makes policies bind the owner too, so there
 *    is no accidental owner bypass. Policies read transaction-local
 *    app.user_id/app.user_role set by withUserContext; without a bound context
 *    (NULL settings) every policy evaluates false => default-deny.
 * 2. audit_log is append-only: UPDATE/DELETE/TRUNCATE raise, plus REVOKEs.
 * 3. Auth tables are reachable only by the application DB role (REVOKE from
 *    PUBLIC); see the note above those tables below.
 */
ALTER TABLE "wallets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "wallets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "wallets_owner_select" ON "wallets" FOR SELECT USING (current_setting('app.user_id', true) IS NOT NULL AND "user_id" = current_setting('app.user_id', true));
--> statement-breakpoint
CREATE POLICY "wallets_owner_insert" ON "wallets" FOR INSERT WITH CHECK ("user_id" = current_setting('app.user_id', true));
--> statement-breakpoint
CREATE POLICY "wallets_owner_update" ON "wallets" FOR UPDATE USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));
--> statement-breakpoint
CREATE POLICY "wallets_owner_delete" ON "wallets" FOR DELETE USING ("user_id" = current_setting('app.user_id', true));
--> statement-breakpoint
CREATE POLICY "wallets_compliance_read" ON "wallets" FOR SELECT USING (current_setting('app.user_role', true) = 'compliance_admin');
--> statement-breakpoint
/* audit_log: RLS enabled but NOT forced. Immutability is enforced by triggers
 * that bind the owner too (UPDATE/DELETE/TRUNCATE always raise); row-level
 * VISIBILITY for the application role is enforced at the API layer by the
 * permission tiers (own events for users, full read for compliance_admin),
 * because the hash-chain append needs global tip visibility. Non-owner DB
 * roles are still fully blocked by RLS with no applicable policies. */
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "audit_owner_or_admin_select" ON "audit_log" FOR SELECT USING ("actor_user_id" = current_setting('app.user_id', true) OR current_setting('app.user_role', true) = 'compliance_admin');
--> statement-breakpoint
CREATE POLICY "audit_context_insert" ON "audit_log" FOR INSERT WITH CHECK (current_setting('app.user_id', true) IS NOT NULL);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_log_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION audit_log_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION audit_log_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON "audit_log" FOR EACH STATEMENT EXECUTE FUNCTION audit_log_forbid_mutation();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM PUBLIC;
--> statement-breakpoint
/* Auth tables (user/session/account/verification/two_factor): RLS is NOT
 * enabled because the Better Auth adapter legitimately queries them without a
 * request-scoped RLS context (sign-up, session validation). Their protection is
 *: (a) REVOKE ALL ... FROM PUBLIC — only the application DB role can reach
 * them; (b) the database is never exposed to end users; (c) sessions are
 * validated per request and passwords are one-way hashed. Application data
 * tables (wallets) carry the RLS enforcement the design doc mandates. */
REVOKE ALL ON "user", "session", "account", "verification", "two_factor" FROM PUBLIC;
--> statement-breakpoint
CREATE INDEX "wallets_user_id_idx" ON "wallets" ("user_id");
--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" ("user_id");

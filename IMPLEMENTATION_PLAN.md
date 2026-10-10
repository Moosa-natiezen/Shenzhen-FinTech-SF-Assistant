# Shenzhen FinTech SF Assistant — Strict Implementation Plan

Derived from: `(PRD)`, `Frontend-` (Design Doc), `Technical Specification`, and
`Security Checks` (Security Assessment) in this repository.

**Stack:** Next.js/TypeScript · Neon Serverless Postgres (PgBouncer pooler) ·
Drizzle ORM · Better Auth (MFA + RBAC) · Hono API gateway.

**Non-negotiable security invariants (apply to EVERY task below):**

| # | Invariant | Source |
|---|-----------|--------|
| I-1 | RBAC: three permission tiers — `student`, `sponsor`, `compliance_admin` — enforced at the API gateway (Better Auth sessions) **and** at the database (Postgres RLS scoped to `user_id`). Deny by default. | Security §1, Tech Spec §3.1 |
| I-2 | Restricted operations (raw balance override, MFA bypass, plaintext PII export, third-party credit lines, schema access) are **never** granted to any role — enforceable only via deny-by-default. | Security §1 matrix |
| I-3 | All money mutations run inside Postgres transactions with `SELECT ... FOR UPDATE` row locks; debits/credits commit atomically or roll back. | Security §2 Risk 2, Tech Spec §2.1 |
| I-4 | FX rates are computed **server-side** (`FX_final = FX_spot × (1 + θ_margin)`), locked with short expiry; client-submitted rates are ignored. | Security §2 Risk 1 |
| I-5 | `sslmode=require` on every Neon connection; TLS 1.3 externally; no plaintext SPII ever persisted (AES-256-GCM, KMS-managed keys, 90-day rotation). | Security §2 Risks 5–6, Tech Spec §3.2 |
| I-6 | Every state-changing transaction writes to the append-only, hash-chained `audit_log` (UPDATE/DELETE/TRUNCATE impossible at the DB level). | Security §2 Risks 3 & 6 |
| I-7 | MFA is mandatory for compliance/admin endpoints; adaptive step-up auth for new payout targets and large transfers; no role can bypass MFA. | Security §2 Risk 4 |
| I-8 | AML: velocity checks + cumulative transfer caps at the gateway; sanctions/PEP screening before routing funds. | Security §2 Risk 3 |
| I-9 | Roles are server-assigned only (default `student`); clients can never grant roles or permissions (mass-assignment defense). | Security §1 |
| I-10 | Money is exact-decimal arithmetic (`numeric`), never floats; amounts are `BIGINT` minor units or `NUMERIC(20,8)`. | Tech Spec §2.1 |

**Definition of Done for every task:** typecheck passes · tests pass ·
security invariants I-1…I-10 re-verified for touched code · no secrets in code ·
audit trail covers the new state changes.

---

## Phase 1 — Foundation & Security Backbone

- [x] **T1. Project scaffold + hardened config + Neon client.** Strict TS; Zod env validation; `sslmode=require` enforced at startup; `.env.example`; Drizzle + Neon pooled client (WebSocket driver for transactions). *(I-5)*
- [x] **T2. Better Auth identity core with RBAC + MFA.** Drizzle adapter; `user.role` server-assigned (default `student`, bootstrap allowlist for admins); admin + two-factor plugins; Access Control Matrix transcribed into `createAccessControl` statements; cookies HTTP-only, cookie-cache disabled. *(I-1, I-2, I-7, I-9)*
- [x] **T3. Database security schema.** Auth tables; `wallets` with `FORCE RLS` scoped to `app.user_id`; append-only hash-chained `audit_log` (trigger-enforced immutability); migrations via Drizzle Kit. *(I-1, I-6)*
- [x] **T4. SPII column encryption.** AES-256-GCM envelope encryption with AAD bound to column+row; keyring from KMS-injected env with key-version rotation. *(I-5)*
- [x] **T5. API gateway guards.** Session verification on every protected route; default-deny `requirePermission`; MFA-enrollment requirement for admin tier; step-up freshness helper; secure headers + strict CORS allowlist; example routes `/api/me`, `/api/wallets` (RLS-scoped), `/api/admin/audit` (compliance tier + chain verification). *(I-1, I-2, I-7)*
- [x] **T6. Verification suite.** Env-validation tests; Access Control Matrix conformance tests (every permitted AND restricted operation from the Security doc); RLS isolation tests; audit immutability + hash-chain tamper-detection tests; end-to-end HTTP auth/RBAC tests over an in-memory Postgres (PGlite) including 2FA challenge and cross-user wallet isolation. *(I-1, I-2, I-6)*

## Phase 2 — Multi-Currency Wallet & Ledger Engine

- [ ] **T7. Double-entry ledger schema.** `ledger_entries` (append-only, signed BIGINT minor units per currency), `balance_snapshots`; RLS + immutability triggers; account state derived from entries. *(I-3, I-6, I-10)*
- [ ] **T8. FX rate service.** Provider-agnostic spot-rate fetch; `FX_final = FX_spot × (1 + θ_margin)`; rate-lock table with 30-second expiry bound to user + amount + pair; client rates ignored; audit every lock. *(I-4, I-6)*
- [ ] **T9. Atomic conversion executor.** `BEGIN` → lock home row `FOR UPDATE` → verify `B_home ≥ A_home + F_flat` → debit home, credit host `(A_home − F_flat) × FX_final`, append ledger entries + audit → `COMMIT`; rollback on any failure; concurrency test (N parallel conversions, exactly one wins per balance). *(I-3, I-4, I-10)*
- [ ] **T10. Sponsor funding & cross-border transfers.** Deposit endpoints (sponsor tier only); sanctions/PEP screening hook (block-on-miss); per-transaction and daily velocity caps + cumulative transfer caps at the gateway; step-up auth for new payout targets and large transfers. *(I-7, I-8)*

## Phase 3 — Tuition Routing & Credit Engine

- [ ] **T11. University directory + tuition payments.** Verified-institution registry; student-tier payment routing; immutable compliance receipts; sponsors get receipt read-only access. *(I-1, I-3, I-6)*
- [ ] **T12. R_score engine.** `R_score = 300 + 550 × (0.40·T_tuition + 0.25·B_bills + 0.15·S_wallet + 0.20·L_repay)`, clamped [300, 850]; computed in Postgres on payment events; score history append-only; student sees only own score. *(I-1, I-6)*
- [ ] **T13. Metro 2 reporting pipeline.** Formatter module; compliance-admin-only export generation; exports contain no plaintext SPII (ciphertext decrypted only inside the export enclave, keys from KMS); every export audited. *(I-2, I-5, I-6)*

## Phase 4 — Web Portal (Design Doc)

- [ ] **T14. App shell + auth flows.** Next.js App Router; sign-up/sign-in with mandatory MFA enrollment for admins; role-aware navigation (single bottom-tab structure); permission-tier badging; high-contrast sponsor mode. *(I-1, I-7)*
- [ ] **T15. Wallet + FX calculator UI.** Dual-currency balance cards; conversion widget showing live rate, θ_margin spread, F_flat fee **before** confirmation (Radical Transparency); rate-lock countdown. *(I-4)*
- [ ] **T16. Tuition portal + Credit Builder dashboard.** Searchable university directory; payment wizard (fees vs. transfer amount breakdown); circular credit gauge with contextual education tooltips. *(design doc)*
- [ ] **T17. Sponsor dashboard.** Funding initiation flow; transfer status; receipt visibility scoped to linked students only (RLS + linkage table). *(I-1)*

## Phase 5 — Hardening & Launch

- [ ] **T18. Security test suite + pen-test prep.** IDOR/RLS cross-tenant tests, MFA-bypass negative tests, race-condition stress on the ledger, rate-limit bypass tests, audit-chain integrity monitor job. *(I-1…I-9)*
- [ ] **T19. Observability & compliance ops.** Structured logs (no PII), alerting on velocity-cap hits and audit-chain failures, admin console for flagged transactions. *(Security §1, §2)*
- [ ] **T20. Launch checklist.** KMS key rotation drill, Neon branch-based staging rehearsal, TLS/cipher verification, backup/restore test, regulatory review sign-off.

---

## Task Execution Log

### T1–T6 (Phase 1 Foundation) — COMPLETED

**Delivered:**
- `src/config/env.ts` — fail-fast env validation; rejects non-TLS DB URLs (`sslmode=require` mandatory), short secrets, non-HTTPS prod origins.
- `src/db/schema/` — Better Auth tables (user/session/account/verification/two_factor incl. admin-plugin and 2FA fields) + `wallets` + `audit_log`.
- `src/db/rls.ts` — transaction-local `set_config('app.user_id'/'app.user_role')` binding via `withUserContext`.
- `src/db/client.ts` — Neon pooled driver (WebSocket; supports `SELECT ... FOR UPDATE` transactions).
- `src/security/permissions.ts` — the Security doc's Access Control Matrix as Better Auth access-control statements; restricted operations exist only so tests can prove no role holds them.
- `src/security/guards.ts` — default-deny gateway guards (`requirePermission`, `requireMfaEnrolled`, `requireFreshAuth`, comma-separated multi-role parsing).
- `src/security/session.ts` — server-side session resolution; rejects missing/banned/impersonated sessions.
- `src/security/spii.ts` — AES-256-GCM SPII envelopes with AAD (column+row) binding and key-version rotation.
- `src/security/audit.ts` — advisory-lock-serialized, hash-chained audit appends + full-chain verification.
- `src/auth/index.ts` — Better Auth (drizzle adapter, admin plugin bound to our roles, two-factor plugin, server-assigned roles, cookie cache disabled).
- `src/server/app.ts` — Hono gateway: secure headers, credentialed CORS allowlist, `/api/auth/*`, `/api/me`, `/api/wallets` (RLS-scoped), `/api/admin/audit` (compliance + MFA + chain verification).
- `drizzle/0000_init.sql` + `drizzle/0001_security_rls.sql` — schema + `FORCE RLS` on wallets, append-only triggers + REVOKEs on audit, RLS-enabled auth tables.

**Verification (all executed, all passing):**
- `npm run typecheck` — clean.
- `npm test` — **55/55 tests pass** across 4 suites, against real Postgres
  semantics (PGlite/PG17 in WASM, running as a non-superuser table-owner role
  exactly like the Neon app role):
  - `permissions.test.ts` (26) — every permitted AND restricted operation of the
    Access Control Matrix; system-wide invariant that no role holds any
    restricted operation; default-deny guards; step-up freshness window.
  - `env.test.ts` (8) — sslmode=require enforcement, secret length, https in prod.
  - `db-security.test.ts` (9) — FORCE-RLS default-deny and owner scoping on
    wallets, cross-owner insert rejected by WITH CHECK, audit_log UPDATE/
    DELETE/TRUNCATE all rejected (trigger binds even the table owner),
    hash-chain serialization + tamper detection.
  - `auth-gateway.test.ts` (12) — end-to-end HTTP through the real gateway and
    Better Auth handler: server-assigned default role, bootstrap-admin allowlist,
    401 without session, cross-user wallet isolation through `/api/wallets`,
    sponsor denied wallet reads, compliance tier blocked without MFA and allowed
    with it (chain verified), 2FA challenge blocks password-only sign-in,
    security headers + CORS allowlist.
- Live HTTP smoke test (`npm run dev`, PGlite-backed): sign-up issues the
  student tier, `/api/me` resolves the session, `/api/wallets` is RLS-scoped,
  `/api/admin/audit` returns 403 for students, foreign origins get no ACAO header.

**Known follow-ups before Phase 2:**
- Neon-backed rate limiting (gateway) — Phase 2/T10.
- Real FX provider integration behind the T8 interface.
- `BOOTSTRAP_ADMIN_EMAILS` must be a deploy-time secret, removed after first admin provisioning.

# Shenzhen FinTech SF Assistant

A unified **cross-border & student-finance platform** that replaces fragmented,
high-fee traditional banking for international students. Families send money
efficiently, students pay tuition seamlessly, and newcomers build a local credit
footprint from day one.

---

## Feature Pillars

| Pillar | Description |
|--------|-------------|
| **Multi-Currency Wallet** | Hold and convert home/host currencies in a single digital wallet with real-time FX. |
| **Tuition Payments** | Direct, low-fee routing to verified university billing systems with compliance receipts. |
| **Credit Building** | An internal reliability score (`R_score`) derived from on-time payments, reported to bureaus. |
| **Remittances** | Low-cost, transparent cross-border transfers with a clear fee-vs-amount breakdown. |

**Core money-movement loop:** Sponsor deposits → FX exchange & settlement →
student's wallet → tuition payment → credit generation.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript (ESM, strict mode) |
| API Gateway | Hono |
| Database | Neon Serverless PostgreSQL (PgBouncer connection pooling) |
| ORM / Migrations | Drizzle ORM + Drizzle Kit |
| Identity & Auth | Better Auth (sessions, MFA/TOTP, RBAC) |
| Validation | Zod |
| Tests | Vitest + PGlite (Postgres compiled to WASM) |

---

## System Architecture

```
   Clients:  Web Portal / Mobile App  (Student, Sponsor, Admin)
      │
      │  TLS 1.3 / HTTPS
      ▼
┌───────────────────────────────────────────────────────────┐
│                 API Gateway & Edge Layer                   │
│  - Session verification (Better Auth)                      │
│  - RBAC guards (default-deny permission checks)            │
│  - Rate limiting / velocity caps                           │
│  - Secure headers + strict CORS allowlist                  │
└───────────────────────────────────────────────────────────┘
      │
      ├──────────────────┬──────────────────────┬────────────────────┐
      ▼                  ▼                      ▼
┌──────────────┐  ┌──────────────────┐  ┌─────────────────────────┐
│ Wallet &     │  │ University       │  │ Credit Building &       │
│ Ledger Engine│  │ Tuition Routing  │  │ Reporting Engine        │
│ (FX, ACID)   │  │ Service          │  │ (R_score → Metro 2)     │
└──────────────┘  └──────────────────┘  └─────────────────────────┘
      │                  │                      │
      └──────────────────┴──────────────────────┘
                         │
                         ▼
┌───────────────────────────────────────────────────────────┐
│            Neon Database (Serverless PostgreSQL)            │
│  • Auth schema (user/session/account)  • RLS policies       │
│  • Wallets (FORCE RLS)                 • Encrypted SPII     │
│  • Append-only hash-chained audit log                       │
└───────────────────────────────────────────────────────────┘
```

### Data flow (FX conversion)

1. Fetch live interbank spot rate `FX_spot` **server-side** (client-submitted rates are ignored).
2. Compute `FX_final = FX_spot × (1 + θ_margin)` and lock the rate with a short expiry.
3. `BEGIN` transaction → `SELECT … FOR UPDATE` on the home balance → verify `B_home ≥ A_home`.
4. Debit home currency, credit host currency `(A_home − F_flat) × FX_final`, append ledger + audit entries.
5. `COMMIT` atomically (or `ROLLBACK` on any failure) — guarantees zero double-spending.

---

## Security Design

Security is enforced in **defense in depth**: at the API gateway, at the
database, and at the column level. No single layer is trusted alone.

### 1. Permission Tiers (RBAC)

Access control follows an explicit **Access Control Matrix** with three tiers,
enforced by Better Auth at the gateway **and** PostgreSQL Row-Level Security at
the database. Checks are **default-deny**: a permission absent from a role is
refused even if a client requests it.

| Tier | Permitted | Restricted |
|------|-----------|-----------|
| **Student** | View own wallet, FX conversions, pay tuition, view own `R_score` | Parent funding details, admin endpoints, schema access, third-party credit lines |
| **Sponsor** | Deposit funds, cross-border transfers, view receipts | Alter student account settings, credit in student's name, modify tuition routing |
| **Compliance / Admin** | Inspect flagged txns, audit FX/ledger logs, export Metro 2 packages | Alter raw balances, bypass MFA, export plaintext PII/SPII |

Restricted operations are never granted to any role, and the test suite asserts
this invariant.

### 2. Row-Level Security (RLS)

- `wallets` uses **`FORCE ROW LEVEL SECURITY`**, so even the table owner is
  bound by policies scoped to `app.user_id`.
- Every query runs inside `withUserContext`, which binds `app.user_id` /
  `app.user_role` via transaction-local `set_config`. With no bound context the
  policies evaluate to false → **zero rows (default-deny)**.
- Auth tables rely on `REVOKE … FROM PUBLIC` (the Better Auth adapter
  legitimately queries them without a request-scoped context).

### 3. Encryption

| State | Mechanism |
|-------|-----------|
| In transit | TLS 1.3 externally; `sslmode=require` enforced on every Neon connection at startup |
| At rest | AES-256 (Neon volumes, WAL, snapshots) |
| Column-level (SPII) | AES-256-GCM with AAD bound to column+row; keyring from KMS-injected env with 90-day rotation |

SPII (passport, national ID, SSN/ITIN, bank account) is encrypted **before**
write; only ciphertext is persisted. Plaintext never touches the database.

### 4. Append-only Audit Trail

- `audit_log` rows can only be `INSERT`ed — `UPDATE` / `DELETE` / `TRUNCATE`
  raise errors via database triggers (they bind even the table owner).
- Rows form a **hash chain**: `rowHash = sha256(prevHash ‖ payload)`, serialized
  under a Postgres advisory lock so concurrent writers cannot fork history.
- `verifyAuditChain` walks the log and reports the first broken link.

### 5. Session & MFA

- Secure **HTTP-only** cookies, server-side session resolution, cookie cache
  disabled.
- MFA (TOTP + backup codes) via Better Auth's two-factor plugin; compliance
  endpoints additionally **require MFA enrollment** — no role can bypass it.
- Step-up freshness window for sensitive actions (new payout targets, large
  transfers).
- Roles are **server-assigned only** (default `student`); clients can never grant
  roles or permissions.

### 6. Config Hardening

`src/config/env.ts` fails fast at startup: rejects non-TLS database URLs, short
secrets, and non-HTTPS production origins.

---

## Getting Started

```bash
# 1. Install dependencies
npm ci

# 2. Configure environment
cp .env.example .env      # then fill in DATABASE_URL, BETTER_AUTH_SECRET, etc.

# 3. Apply database migrations
npm run db:migrate        # or: npm run db:generate && npm run db:migrate

# 4. Run the test suite
npm test

# 5. Start a local dev server (PGlite-backed, production RLS semantics)
npm run dev
```

### Environment variables

| Variable | Required | Notes |
|----------|----------|-------|
| `DATABASE_URL` | ✅ | Must include `sslmode=require` (enforced at startup) |
| `BETTER_AUTH_SECRET` | ✅ | ≥ 32 chars; never commit the real value |
| `BETTER_AUTH_URL` | ✅ | Public origin (`https://` in production) |
| `ALLOWED_ORIGINS` | ✅ | Comma-separated CORS allowlist |
| `BOOTSTRAP_ADMIN_EMAILS` | optional | Server-side allowlist for provisioning the first compliance admin; remove after use |

Secrets stay in `.env` (git-ignored). See `.env.example` for the template.

---

## Testing

```bash
npm run typecheck   # strict TypeScript
npm test            # Vitest
```

Tests run against **real Postgres semantics** (PGlite in WASM) executing the
production migrations as a non-superuser table-owner role — identical to the
Neon app role. Coverage includes:

- Access Control Matrix conformance (permitted **and** restricted operations)
- RLS isolation (default-deny, owner scoping, cross-owner rejection)
- Audit immutability + hash-chain tamper detection
- SPII encryption (AAD binding, tamper detection, key rotation)
- End-to-end HTTP auth/RBAC incl. the 2FA challenge flow
- Env hardening (TLS, secrets, HTTPS)

---

## Project Layout

```
src/
├── config/env.ts          # Zod-validated, hardened environment loader
├── db/
│   ├── client.ts          # Neon serverless (WebSocket) client
│   ├── rls.ts             # withUserContext (RLS context binding)
│   ├── schema/            # Drizzle schema (auth + app tables)
│   └── pglite-dev-role.ts # Reproduces Neon permissions for dev/tests
├── auth/index.ts          # Better Auth config (RBAC + MFA)
├── security/
│   ├── permissions.ts     # Access Control Matrix as code
│   ├── guards.ts          # Default-deny gateway guards
│   ├── session.ts         # Server-side session resolution
│   ├── audit.ts           # Hash-chained append-only audit log
│   └── spii.ts            # AES-256-GCM SPII encryption
└── server/
    ├── app.ts             # Hono API gateway
    ├── index.ts           # Production entrypoint (Neon)
    └── dev.ts             # Local dev entrypoint (PGlite)
drizzle/                   # SQL migrations + journal
tests/                     # Vitest suites
IMPLEMENTATION_PLAN.md     # Phased build roadmap + security invariants
```

---

## Implementation Roadmap

See **[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md)** for the full phased
plan with security invariants (I-1…I-10) and Definition of Done per task.

- ✅ **Phase 1 — Foundation & Security Backbone** (complete)
- ✅ **Phase 2 — Multi-Currency Wallet & Ledger Engine** (complete)
- ✅ **Phase 3 — Tuition Routing & Credit Engine** (complete)
- ⬜ Phase 4 — Web Portal
- ⬜ Phase 5 — Hardening & Launch

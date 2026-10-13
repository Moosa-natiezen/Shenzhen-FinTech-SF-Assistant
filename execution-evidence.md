# [06] Execution Evidence — Shenzhen FinTech SF Assistant

> End-to-end user journey executed against the local database schema by
> `scripts/generate-evidence.ts` on **2026-10-13T14:51:51.713Z**.
> Every value below was read back from the database or the structured log
> sink after the run — nothing is hand-transcribed.

## Run context

| Item | Value |
| --- | --- |
| Database | PGlite (Postgres wire-compatible) + the production drizzle migration chain `0000 → 0005`, RLS bound through the app role |
| Gateway | Real Hono app (`buildApp`) + Better Auth session cookies — the same code path a browser uses |
| Actors | sponsor `AECJD1H9uITnfRJx3anRoJ3RiMSwWR4R` · student `8IaLBciRBhqLRiTk8gWvWMkmrY0ESmu5` (pseudonymous ids; the simulation's email addresses never reach a log line or this document) |
| Amounts | exact decimal strings end-to-end (`NUMERIC(20,8)`) — no IEEE-754 value touches the ledger |
| Log sink | `src/observability/logger.ts` — one NDJSON object per line |
| Audit chain | sha256 hash chain over `audit_log`, verified **7 events** after the run |

## Verification summary

| # | Event | HTTP | Ledger transaction | Ledger tx hash (sha256) | Audit chain link |
| --- | --- | --- | --- | --- | --- |
| 1 | Sponsor funding — deposit | `POST /api/funding/deposit` 200 | `a002dbb5-a7f1-4fea-b18f-6f10c2824590` | `8ff2e48d82d79955227a2a90…` | `genesis… → 0f2e91432b451a42…` |
| 1 | Sponsor funding — relay to student | `POST /api/funding/transfer` 200 | `7f04d066-aafa-4ef8-a0f4-5240ebc7a8ed` | `fec54e087025cf8c227b9c65…` | `0f2e91432b451a42… → 23e40e216430d92b…` |
| 2 | FX conversion (30s lock consumed) | `POST /api/fx/convert` 200 | `710bf3f5-b869-47ac-be09-07906e0b3ae1` | `563bc1af6ec4612bc9cbcbef…` | `1d00030e4086ab0f… → 3036a0cf303db6d9…` |
| 3 | Tuition routing (verified institution) | `POST /api/tuition/pay` 200 | `f23b2a6f-fa60-4e6a-b86b-4903bc926eee` | `0b54b89a5d4669206419d946…` | `3036a0cf303db6d9… → 668ff14b44e7e3a1…` |
| 4 | Credit engine — R_score saved | `GET /api/credit/score` 200 | r_score snapshot `c636acf4-52d7-41d7-bccf-22a3ae7f631c` | — | `8367271a992d5a90… → 3a5460d3163b3443…` |

Full 64-character digests are listed per step below.

## Step 1 — Sponsor funding

A sponsor deposits **20000 CNY** into the home-currency wallet, then relays **8000 CNY** to the student's home wallet (the production `deposit → payout` sequence). Both postings are double-entry: the platform system clearing wallet is the offsetting counterparty.

### Structured observability log (PII-free)

```json
{"ts":"2026-10-13T14:51:55.785Z","level":"info","event":"http.request","method":"POST","path":"/api/funding/deposit","status":200,"durationMs":56,"userId":null}
{"ts":"2026-10-13T14:51:55.815Z","level":"info","event":"http.request","method":"POST","path":"/api/funding/transfer","status":200,"durationMs":29,"userId":null}
```

### Append-only ledger legs

| Posting | Leg | Wallet | Owner | Currency | Amount (signed, 8 dp) | Type | Kind |
| --- | --- | --- | --- | --- | --- | --- | --- |
| deposit | #1 | `ev-sponsor-cny` | `AECJD1H9…` | CNY | 20000.00000000 | credit | deposit |
| deposit | #2 | `sys-wallet-cny` | `system…` | CNY | -20000.00000000 | debit | deposit |
| relay | #1 | `ev-sponsor-cny` | `AECJD1H9…` | CNY | -8000.00000000 | debit | transfer |
| relay | #2 | `ev-student-cny` | `8IaLBciR…` | CNY | 8000.00000000 | credit | transfer |

Per-currency sums: deposit CNY = 0.00000000 · relay CNY = 0.00000000 — balanced double-entry.

### Ledger transaction hashes

```json
deposit  sha256 = 8ff2e48d82d79955227a2a900209a93fe45ff2c5e5f4162bf53e7bc48d9d1cfc
payload  = {"transactionId":"a002dbb5-a7f1-4fea-b18f-6f10c2824590","legs":[{"walletId":"ev-sponsor-cny","currency":"CNY","amount":"20000.00000000","entryType":"credit","kind":"deposit"},{"walletId":"sys-wallet-cny","currency":"CNY","amount":"-20000.00000000","entryType":"debit","kind":"deposit"}]}
```

```json
relay    sha256 = fec54e087025cf8c227b9c656ed366301f0e935bf2c52dd46ec4ba281571d68e
payload  = {"transactionId":"7f04d066-aafa-4ef8-a0f4-5240ebc7a8ed","legs":[{"walletId":"ev-sponsor-cny","currency":"CNY","amount":"-8000.00000000","entryType":"debit","kind":"transfer"},{"walletId":"ev-student-cny","currency":"CNY","amount":"8000.00000000","entryType":"credit","kind":"transfer"}]}
```

### Audit chain links

| Action | Entity | prev_hash → row_hash |
| --- | --- | --- |
| `funding.deposit` | transfer `942cde2c-b536-44d6-aaf1-98a5faf1508d` | `genesis… → 0f2e91432b451a42…` |
| `funding.transfer` | transfer `5a308551-e8af-47e5-ac7a-342c10543bdf` | `0f2e91432b451a42… → 23e40e216430d92b…` |

> Full digests:
>
> - `funding.deposit` prev `genesis`
> - `funding.deposit` row `0f2e91432b451a428506a28e75b419b1c40f16649d2438981a93f2c068edeed7`
> - `funding.transfer` prev `0f2e91432b451a428506a28e75b419b1c40f16649d2438981a93f2c068edeed7`
> - `funding.transfer` row `23e40e216430d92b64fe56a7848573dba20f788034b7d85d04a7239b7f84d78a`

## Step 2 — Multi-currency conversion (consumed 30-second rate lock)

The client submits a **lock id, never a rate**: `FX_final = FX_spot × (1 + θ)` is priced server-side, the lock is single-use, bound to user + pair + amount, and is marked `consumed_at` inside the same transaction as the posting.

| Field | Value |
| --- | --- |
| Lock id | `c4341507-f99f-4aa0-9067-0de9738cff0b` |
| Pair | CNY → GBP |
| FX_spot (server-priced) | `0.11` |
| Margin θ | `0.002` |
| **FX_final (executed)** | `0.11022000` |
| Amount (base) | `5000` CNY |
| Flat fee | `0` CNY |
| TTL | **30s** (2026-10-13T14:51:55.870Z → 2026-10-13T14:52:25.870Z) |
| Consumed at | 2026-10-13T14:51:55.882Z (single-use, enforced by trigger-less row state + `FOR UPDATE`) |
| Credited (host) | `551.10000000` GBP = (5000 − 0) × 0.11022000 |

### Structured observability log (PII-free)

```json
{"ts":"2026-10-13T14:51:55.874Z","level":"info","event":"http.request","method":"POST","path":"/api/fx/rate","status":200,"durationMs":39,"userId":null}
{"ts":"2026-10-13T14:51:55.912Z","level":"info","event":"http.request","method":"POST","path":"/api/fx/convert","status":200,"durationMs":37,"userId":null}
```

### Append-only ledger legs (4-leg balanced posting)

| Leg | Wallet | Owner | Currency | Amount (signed, 8 dp) | Type | Kind |
| --- | --- | --- | --- | --- | --- | --- |
| #1 | `ev-student-cny` | `8IaLBciR…` | CNY | -5000.00000000 | debit | fx.convert |
| #2 | `ev-student-gbp` | `8IaLBciR…` | GBP | 551.10000000 | credit | fx.convert |
| #3 | `sys-wallet-cny` | `system…` | CNY | 5000.00000000 | credit | fx.convert |
| #4 | `sys-wallet-gbp` | `system…` | GBP | -551.10000000 | debit | fx.convert |

Per-currency sums: CNY = 0.00000000, GBP = 0.00000000 — balanced within each currency.

### Ledger transaction hash

```json
convert  sha256 = 563bc1af6ec4612bc9cbcbef6e70763848946294d989b8b67169d8d82478e90c
payload  = {"transactionId":"710bf3f5-b869-47ac-be09-07906e0b3ae1","legs":[{"walletId":"ev-student-cny","currency":"CNY","amount":"-5000.00000000","entryType":"debit","kind":"fx.convert"},{"walletId":"ev-student-gbp","currency":"GBP","amount":"551.10000000","entryType":"credit","kind":"fx.convert"},{"walletId":"sys-wallet-cny","currency":"CNY","amount":"5000.00000000","entryType":"credit","kind":"fx.convert"},{"walletId":"sys-wallet-gbp","currency":"GBP","amount":"-551.10000000","entryType":"debit","kind":"fx.convert"}]}
```

### Audit chain links

| Action | Entity | prev_hash → row_hash |
| --- | --- | --- |
| `fx.rate.lock` | rate_lock `c4341507-f99f-4aa0-9067-0de9738cff0b` | `23e40e216430d92b… → 1d00030e4086ab0f…` |
| `fx.convert` | ledger_transaction `710bf3f5-b869-47ac-be09-07906e0b3ae1` | `1d00030e4086ab0f… → 3036a0cf303db6d9…` |

Full `fx.convert` row hash: `3036a0cf303db6d9ae6b6c03190be674b79e7316abde754f38c8ca692d36ab25`

## Step 3 — Tuition routing to a verified institution

| Field | Value |
| --- | --- |
| Institution | University College London (`uni-ucl`, GB, verified) |
| Billing currency | GBP |
| Amount | `500.00000000` GBP |
| Wallet debited | `ev-student-gbp` (host wallet) |
| Receipt id | `30871ecf-1b09-4733-8c9d-a67d2aee1505` |
| Status | `settled` |
| **Receipt hash (sha256 seal)** | `1f84807a2d500470e85a5b1ef02bd043dd3c5c136fb730862e0a72b5ce46432b` |
| Ledger transaction | `f23b2a6f-fa60-4e6a-b86b-4903bc926eee` |
| R_score side-effect | payment settled → automatic recompute recorded score **438** |

### Structured observability log (PII-free)

```json
{"ts":"2026-10-13T14:51:55.987Z","level":"info","event":"http.request","method":"GET","path":"/api/universities","status":200,"durationMs":10,"userId":null}
{"ts":"2026-10-13T14:51:56.018Z","level":"info","event":"http.request","method":"POST","path":"/api/tuition/pay","status":200,"durationMs":30,"userId":null}
```

### Append-only ledger legs

| Leg | Wallet | Owner | Currency | Amount (signed, 8 dp) | Type | Kind |
| --- | --- | --- | --- | --- | --- | --- |
| #1 | `ev-student-gbp` | `8IaLBciR…` | GBP | -500.00000000 | debit | tuition |
| #2 | `sys-wallet-gbp` | `system…` | GBP | 500.00000000 | credit | tuition |

Per-currency sums: GBP = 0.00000000 — balanced double-entry.

### Ledger transaction hash

```json
tuition  sha256 = 0b54b89a5d4669206419d94622379e23e0fcb9a51ec392a79f90749ad4b7da0f
payload  = {"transactionId":"f23b2a6f-fa60-4e6a-b86b-4903bc926eee","legs":[{"walletId":"ev-student-gbp","currency":"GBP","amount":"-500.00000000","entryType":"debit","kind":"tuition"},{"walletId":"sys-wallet-gbp","currency":"GBP","amount":"500.00000000","entryType":"credit","kind":"tuition"}]}
```

### Audit chain link

`tuition.pay` prev → row: `3036a0cf303db6d9… → 668ff14b44e7e3a1…` · full row hash `668ff14b44e7e3a184e9a21326bf19fed09b0a31f3cba83ac0e581692169c197`

## Step 4 — Credit engine: R_score recalculated and saved

| Component | Weight | Derived value | Contribution |
| --- | --- | --- | --- |
| T_tuition (tuition timeliness) | 0.40 | `0.25` (1 settled payment ÷ 4 on-time term) | 0.1000 |
| B_bills (recurring bills) | 0.25 | `0` (bills pipeline not yet active) | 0.0000 |
| S_wallet (balance stability) | 0.15 | `1` (held balance vs 2000 stability target) | 0.1500 |
| L_repay (micro-credit cadence) | 0.20 | `0` (micro-credit pipeline not yet active) | 0.0000 |

`R = clamp(300 + 550 × Σ wᵢxᵢ, 300, 850)` computed with scaled BigInt (no floats) → **R = 438**, persisted as an append-only `r_score_snapshots` row with trigger `evidence.recompute`.

### Structured observability log (PII-free)

```json
{"ts":"2026-10-13T14:51:56.070Z","level":"info","event":"credit.rscore.recompute","studentId":"8IaLBciRBhqLRiTk8gWvWMkmrY0ESmu5","score":438,"trigger":"evidence.recompute","tTuition":0.25,"bBills":0,"sWallet":1,"lRepay":0}
{"ts":"2026-10-13T14:51:56.076Z","level":"info","event":"http.request","method":"GET","path":"/api/credit/score","status":200,"durationMs":6,"userId":null}
```

### Saved score history (append-only — UPDATE/DELETE are rejected by trigger)

| # | Score | T_tuition | B_bills | S_wallet | L_repay | Trigger | Computed at |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 438 | 0.25000 | 0.00000 | 1.00000 | 0.00000 | `tuition.settled` | 2026-10-13T14:51:56.013Z |
| 2 | 438 | 0.25000 | 0.00000 | 1.00000 | 0.00000 | `evidence.recompute` | 2026-10-13T14:51:56.038Z |

Row 1 was appended automatically when the tuition payment settled (T12); row 2 is this run's explicit recompute — identical values, proving the calculation is deterministic.

### Audit chain links

| Action | Entity | prev_hash → row_hash |
| --- | --- | --- |
| `credit.rscore.record` | snapshot `1b7221db-3c85-481f-97bb-df415f3e3c21` | `668ff14b44e7e3a1… → 8367271a992d5a90…` |
| `credit.rscore.record` | snapshot `c636acf4-52d7-41d7-bccf-22a3ae7f631c` | `8367271a992d5a90… → 3a5460d3163b3443…` |

## Exact-decimal balance snapshots

`wallets.balance` is only a cache: every row below is compared against the **derived** balance `SUM(ledger_entries.amount)` recomputed from the append-only legs. They match at every step (invariant I-1).

### initial

| Wallet | Owner | Ccy | Cached balance | Derived Σ legs | Match |
| --- | --- | --- | --- | --- | --- |
| `ev-sponsor-cny` | `AECJD1H9…` | CNY | 0.00000000 | 0.00000000 | ✅ |
| `ev-student-cny` | `8IaLBciR…` | CNY | 0.00000000 | 0.00000000 | ✅ |
| `ev-student-gbp` | `8IaLBciR…` | GBP | 0.00000000 | 0.00000000 | ✅ |
| `sys-wallet-cny` | `system` | CNY | 0.00000000 | 0.00000000 | ✅ |
| `sys-wallet-gbp` | `system` | GBP | 0.00000000 | 0.00000000 | ✅ |

### after step 1 (sponsor funding)

| Wallet | Owner | Ccy | Cached balance | Derived Σ legs | Match |
| --- | --- | --- | --- | --- | --- |
| `ev-sponsor-cny` | `AECJD1H9…` | CNY | 12000.00000000 | 12000.00000000 | ✅ |
| `ev-student-cny` | `8IaLBciR…` | CNY | 8000.00000000 | 8000.00000000 | ✅ |
| `ev-student-gbp` | `8IaLBciR…` | GBP | 0.00000000 | 0.00000000 | ✅ |
| `sys-wallet-cny` | `system` | CNY | -20000.00000000 | -20000.00000000 | ✅ |
| `sys-wallet-gbp` | `system` | GBP | 0.00000000 | 0.00000000 | ✅ |

### after step 2 (multi-currency conversion)

| Wallet | Owner | Ccy | Cached balance | Derived Σ legs | Match |
| --- | --- | --- | --- | --- | --- |
| `ev-sponsor-cny` | `AECJD1H9…` | CNY | 12000.00000000 | 12000.00000000 | ✅ |
| `ev-student-cny` | `8IaLBciR…` | CNY | 3000.00000000 | 3000.00000000 | ✅ |
| `ev-student-gbp` | `8IaLBciR…` | GBP | 551.10000000 | 551.10000000 | ✅ |
| `sys-wallet-cny` | `system` | CNY | -15000.00000000 | -15000.00000000 | ✅ |
| `sys-wallet-gbp` | `system` | GBP | -551.10000000 | -551.10000000 | ✅ |

### after step 3 (tuition routing)

| Wallet | Owner | Ccy | Cached balance | Derived Σ legs | Match |
| --- | --- | --- | --- | --- | --- |
| `ev-sponsor-cny` | `AECJD1H9…` | CNY | 12000.00000000 | 12000.00000000 | ✅ |
| `ev-student-cny` | `8IaLBciR…` | CNY | 3000.00000000 | 3000.00000000 | ✅ |
| `ev-student-gbp` | `8IaLBciR…` | GBP | 51.10000000 | 51.10000000 | ✅ |
| `sys-wallet-cny` | `system` | CNY | -15000.00000000 | -15000.00000000 | ✅ |
| `sys-wallet-gbp` | `system` | GBP | -51.10000000 | -51.10000000 | ✅ |

### after step 4 (credit engine)

| Wallet | Owner | Ccy | Cached balance | Derived Σ legs | Match |
| --- | --- | --- | --- | --- | --- |
| `ev-sponsor-cny` | `AECJD1H9…` | CNY | 12000.00000000 | 12000.00000000 | ✅ |
| `ev-student-cny` | `8IaLBciR…` | CNY | 3000.00000000 | 3000.00000000 | ✅ |
| `ev-student-gbp` | `8IaLBciR…` | GBP | 51.10000000 | 51.10000000 | ✅ |
| `sys-wallet-cny` | `system` | CNY | -15000.00000000 | -15000.00000000 | ✅ |
| `sys-wallet-gbp` | `system` | GBP | -51.10000000 | -51.10000000 | ✅ |

## Append-only balance snapshot trail

| # | Occurred at | Wallet | Currency | Snapshot balance |
| --- | --- | --- | --- | --- |
| 1 | 2026-10-13T14:51:55.738Z | `ev-sponsor-cny` | CNY | 20000.00000000 |
| 2 | 2026-10-13T14:51:55.738Z | `sys-wallet-cny` | CNY | -20000.00000000 |
| 3 | 2026-10-13T14:51:55.795Z | `ev-sponsor-cny` | CNY | 12000.00000000 |
| 4 | 2026-10-13T14:51:55.795Z | `ev-student-cny` | CNY | 8000.00000000 |
| 5 | 2026-10-13T14:51:55.879Z | `ev-student-cny` | CNY | 3000.00000000 |
| 6 | 2026-10-13T14:51:55.879Z | `ev-student-gbp` | GBP | 551.10000000 |
| 7 | 2026-10-13T14:51:55.879Z | `sys-wallet-cny` | CNY | -15000.00000000 |
| 8 | 2026-10-13T14:51:55.879Z | `sys-wallet-gbp` | GBP | -551.10000000 |
| 9 | 2026-10-13T14:51:55.993Z | `ev-student-gbp` | GBP | 51.10000000 |
| 10 | 2026-10-13T14:51:55.993Z | `sys-wallet-gbp` | GBP | -51.10000000 |

## Audit-chain integrity

| Check | Result |
| --- | --- |
| Events in chain | 7 |
| Recomputed sha256 links | ✅ all links verify (`prev_hash` continuity + payload digest) |
| Head row hash | `3a5460d3163b344311e9770c1bf007d36ae53258cfe45e24942429d634b89708` |
| Append-only enforcement | DB triggers reject UPDATE/DELETE/TRUNCATE on `audit_log` and `ledger_entries` (verified by the security suite) |

## PII / SPII log hygiene proof

The logger scrubs by **key** (`email`, `passport`, `name`, tokens…) and by **value shape** (email-shaped strings, JWT/bearer material, 9+ digit runs) *before* serialization, so a caller cannot leak PII by passing a raw request body. A deliberate attempt was emitted during this run:

```json
{"ts":"2026-10-13T14:51:56.093Z","level":"info","event":"evidence.pii_scrub_demo","email":"[redacted]","note":"student reference [redacted-email]","passport":"[redacted]","studentId":"8IaLBciRBhqLRiTk8gWvWMkmrY0ESmu5"}
```

| Check | Result |
| --- | --- |
| Log lines captured | 13 |
| Lines containing an actor email | 0 ✅ |
| Lines containing the account password | 0 ✅ |
| Allowed identifier | pseudonymous UUID only (`studentId` passes through unmodified) |

> Evidence of the scan:
>
> `grep -c 'evidence.example.com\|<account password>' <captured logs> = 0` (the literal values are never echoed into this document)

## Reproduce

```bash
npx tsx scripts/generate-evidence.ts   # regenerates this file
```

The script exits non-zero (and writes nothing) if any invariant fails: balanced posting, cached-vs-derived balance, lock consumption, 30-second TTL, receipt hash shape, score consistency, audit-chain verification, or a PII leak in the captured logs.

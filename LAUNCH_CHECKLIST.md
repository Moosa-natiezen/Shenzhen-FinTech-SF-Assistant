# Launch Checklist — Shenzhen FinTech SF Assistant

Phase 5 (T20). Every gate must be green and evidenced before production
traffic is enabled. Owners: Eng (release) / Compliance (regulatory) / Ops (infra).

---

## 1. Staging Rehearsal (Neon branch-based)

Neon's copy-on-write branching gives an isolated, production-shaped staging
environment without copying data pipelines (Tech Spec §1).

**Procedure**

```bash
# 1. Branch production (isolated; no prod data leaves the branch store)
neonctl branches create --parent $PROD_BRANCH --name staging-$(git rev-parse --short HEAD)

# 2. Point the rehearsal at the branch (TLS required — env validator enforces)
export DATABASE_URL="$STAGING_BRANCH_URL?sslmode=require"

# 3. Run the automated rehearsal (branch -> migrate -> smoke -> audit chain)
npm run rehearse:staging
```

**Automated smoke covers** (`scripts/staging-rehearsal.ts`):
- signup + server-assigned role (I-9)
- server-priced FX lock (exact `0.11 * 1.002 = 0.11022000`) (I-4)
- ledger atomic guard rejects unfunded conversion (no overdraft) (I-3)
- verified-institution directory only (T11)
- full audit-chain verification (I-2)

**Gate**: rehearsal exits 0; results attached to the release ticket.
Delete the branch after sign-off: `neonctl branches delete staging-…`.

> The repo-local rehearsal uses PGlite (same engine as CI) as the
> copy-on-write analogue; the `neonctl` steps above are the production mapping.
> Because PGlite is single-connection, true row-lock contention is validated on
> the Neon staging branch itself (run the stress suite there once).

## 2. TLS / Cipher Verification

**Policy**: TLS 1.2 minimum (1.3 preferred), AEAD suites only
(GCM / ChaCha20-Poly1305); no CBC/RC4/3DES.

```bash
# Edge / CDN and Neon endpoint
npm run verify:tls -- api.your-domain.com 443
npm run verify:tls -- <neon-endpoint-host> 5432   # via stunnel/proxy if needed
```

Automated in CI: `tests/security-suite.test.ts` spins a local TLS 1.3
endpoint and asserts (a) trusted-CA pass and (b) untrusted-CA fail.

Additionally confirm:
- [ ] `DATABASE_URL` uses `sslmode=require` (or stronger) — **enforced at boot**
      by the env validator (`src/config/env.ts`); boot fails otherwise.
- [ ] HSTS + secure headers present (asserted by gateway tests).
- [ ] CORS allowlist contains only https origins in production (env validator).

## 3. Backup / Restore Test

**Monthly drill (evidence: screenshot/log of timing + row counts)**

1. **Backup** (Neon): confirm PITR retention ≥ 7 days; take an instant restore
   branch: `neonctl branches create --parent $PROD --name restore-drill-$(date +%F)`.
2. **Restore objective**: RPO ≤ 5 min (Neon WAL archiving), RTO ≤ 30 min
   (branch creation is typically < 1 min; budget the remainder for smoke).
3. **Verify on the restore branch**:
   - `npm run rehearse:staging` against the restore branch (green = data +
     schema intact),
   - `npm run audit:monitor` — the hash chain must verify across ALL history
     (a restore that silently lost or reordered audit rows FAILS here),
   - spot-check: wallet `SUM(ledger_entries.amount)` equals cached balances
     for a sample of accounts (double-entry integrity after restore).
4. Record RPO/RTO achieved vs. objective; open an incident if exceeded.

**Append-only caveat**: audit_log rows can never be edited to "fix" a restored
gap — a genuine gap is a security incident, handled per IR runbook, not by
data surgery.

## 4. KMS Key Rotation Drill (90-day, Security §3.2)

1. Provision the new key version in KMS (`SPII_KEY_ID=k2`, new master payload).
2. Deploy with BOTH keys readable (keyring accepts multiple versions;
   new writes use the current id, reads accept any listed version).
3. Verify: an export of pre-rotation SPII still decrypts (enclave smoke).
4. Re-encrypt sweep (batch job) rewrites old envelopes under `k2`.
5. Retire `k1` from the keyring only after the sweep completes; a decrypt
   against a rotated-out id raises `SpiiCryptoError` (alert-worthy by design).
6. Record rotation timestamp + evidence in the compliance register.

## 5. Security Sign-off (T18 evidence)

- [ ] `npm test` green — includes the pen-test suite:
      IDOR/RLS cross-tenant, MFA/session bypass negatives, rate-limit
      enforcement + bypass attempts, ledger race stress, audit-chain monitor,
      zero-PII logging assertions.
- [ ] Rate-limit profile reviewed for production traffic (defaults:
      auth 10/min/IP, money 30/min/user, global 300/min/IP; multi-instance
      deployments must back `RateLimiter` with a shared store — interface is
      already isolated for that swap).
- [ ] Audit-chain monitor interval accepted by compliance
      (`AUDIT_MONITOR_INTERVAL_MS`, default 1h; alerts on break are CRITICAL).
- [ ] No secrets in the repo: `git log -p | grep -E "ghp_|github_pat_|BEGIN RSA"` empty.

## 6. Regulatory Review Sign-off

Owner: Compliance. Artifacts retained in the compliance register.

- [ ] **Data residency**: student financial data stored in-region; Neon project
      region confirmed; no SPII in logs/exports (enforced + tested: the Metro-2
      enclave emits tokenized references only).
- [ ] **Cross-border transfer review**: sponsor-initiated cross-border transfers
      documented (purpose, data elements, legal basis); screening is
      block-on-miss (a provider outage BLOCKS, never passes).
- [ ] **Credit-bureau reporting**: Metro-2 segment definitions reviewed against
      bureau spec; export checksums retained per submission.
- [ ] **Consumer disclosures**: R_score is educational/assistive — disclosure
      that it is NOT a regulated FICO/credit-bureau score shown in-product
      (Credit Builder tooltips).
- [ ] **Sanctions program**: screening provider contract active; alert trail
      (velocity caps, screening blocks) reviewable at `/api/admin/flagged`.
- [ ] **Pen-test report** (external): findings triaged; criticals closed.
- [ ] **Incident runbook** reviewed: audit-chain-broken alert → IR procedure.

## 7. Go-Live Gate

| Gate | Owner | Evidence |
|---|---|---|
| Staging rehearsal green | Eng | rehearsal log |
| TLS/cipher verification | Ops | verify:tls output |
| Backup/restore drill | Ops | RPO/RTO record |
| KMS rotation drill | Security | register entry |
| Full test suite green | Eng | CI run |
| Regulatory sign-off | Compliance | register entry |

No gate = no launch. Partial launches (e.g. invite-only) require the same
gates except the regulatory sign-off may be scoped to the launch region.

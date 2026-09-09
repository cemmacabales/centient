# Deliverable 1 — QA readiness

**Frozen build:** `bbaf4266684e799e84212e6059751b1d1099f3c8`
**Environment:** Railway `centient-work` / `production` · https://centient.work
**Network:** Stellar **Testnet** only · **Refreshed:** 2026-09-09

This is the developer-to-QA handoff for [#13](https://github.com/webnxt-2030/Centient/issues/13).
It supersedes the PDF guide in [PR #81](https://github.com/webnxt-2030/Centient/pull/81),
which froze `fa36cf4663fe` — two builds behind — and stated several things that
later turned out to be wrong. Where the two disagree, this document is right.

QA execution and the `QA:PASSED` label live on
[#80](https://github.com/webnxt-2030/Centient/issues/80). Nothing here records a
QA verdict.

---

## 1. The build under test

Both services run the same commit. That is the point of the freeze.

| | |
| --- | --- |
| `web` | `bbaf426`, deployed 2026-09-09 09:30 UTC, SUCCESS |
| `cosigner` | `bbaf426`, deployed 2026-09-09 09:25 UTC, SUCCESS |
| CI on that exact SHA | `build`, `payments-lane`, `verify-commit-identities` — all green |

CI runs on push to `develop` as well as on pull requests, so the green run is
**on the deployed commit itself**. Earlier versions of this guide had to argue
forward from a merge parent; that argument is retired and D1-TC-025 no longer
depends on it.

**If the deployed SHA moves during the run, QA is notified and affected cases
are reset.** The freeze is a promise about the environment, not about the branch.

### What changed since the previous freeze

Three commits landed after `596dbc2`, and one of them is behavioural:

| Commit | Effect on QA |
| --- | --- |
| `aa5e91b` | **The co-signer's daily cap is charged once per payout, not once per signature.** Re-run any executed case that touched the co-signer cap. |
| `f1e94e1` | `extractBalances` deleted. No runtime path changed. |
| `bbaf426` | Import-style change in the QA fixtures. No behaviour. |

Before `aa5e91b`, one payout asked for two signatures carrying the same amount
and was charged for both, so `COSIGNER_DAILY_CAP_UNITS` held to roughly half its
configured value. It now means what the runbook says it means. **The configured
value was deliberately left unchanged** — see the decision register, D-01.

---

## 2. Accounts and on-chain facts

| | |
| --- | --- |
| Payout (hot) account | [`GCP34RIT…4BUO`](https://stellar.expert/explorer/testnet/account/GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO) — 2-of-3, thresholds 2/2/2, three weight-1 signers |
| `set-options` proof | [`e966c0a5…30fd`](https://stellar.expert/explorer/testnet/tx/e966c0a5c27cbe0253f2812d158b38f8e91513de48254923f9ecb6f4c19630fd) |
| Cold reserve | `GDPGRS4P…` |
| Ops signer | `GAHZKJFAWX3HXAYQFAPCJ3Y2DFHYBOCSNVBJTZRDYJXN763KIR6HZ2U6` |
| Policy signer | `GCAUNAS2ZHBROHNKP32KWMEPJGMX5XJMSGNKXV3YVMRZ72SFBL3PKHIU` |

**Every other account in `docs/stellar-multisig-runbook.md` and the spike
document is historical.** Those accounts are also correctly configured 2-of-3
accounts on testnet, which is exactly why the distinction matters: a threshold
check against the wrong one passes while proving nothing about the build under
test. Each document now carries a notice saying so.

---

## 3. Environment state

Set on `web`, verified against the deployed service rather than copied from an
issue:

`CRON_SECRET` · `DISCORD_WEBHOOK_URL` · `REDIS_URL` · `HEALTH_ALERT_COOLDOWN_MS` ·
`COSIGNER_URL` · `COSIGNER_SHARED_SECRET` · `COSIGNER_ISOLATION_LEVEL` ·
`DAILY_PAYOUT_CAP_UNITS` · `STELLAR_OPS_SIGNER_SECRET` ·
`STELLAR_POLICY_SIGNER_PUBLIC` · all six cold-reserve variables.

`PAYOUT_PRIVATE_KEY` — the dead EVM-era key with zero readers — is deleted.
`STELLAR_PLATFORM_SECRET` is retained: it is still read by
`lib/stellar/balance.ts`, `lib/stellar/client.ts` and
`lib/stellar/reserve-refill.ts`. An earlier checklist called for its removal;
that checklist was wrong.

### Cold reserve policy

| Value | Setting |
| --- | --- |
| Refill trigger | `100000000` — 10 USDC |
| Refill target | `120000000` — 12 USDC |
| Retained cold minimum | `50000000` — 5 USDC |

1 USDC = 10,000,000 units (`UNITS_PER_USDC`, `lib/stellar/config.ts`). These are
the values already in `docs/stellar-cold-reserve-runbook.md` and the ones the
recorded refill transaction used; choosing different numbers would have
invalidated on-chain evidence QA cross-references. **They are a testnet policy
and are on the mainnet review list (D-06).**

### Live balances at time of writing

| Account | USDC |
| --- | --- |
| Hot float | 34.0000 |
| Cold reserve | 26.9000 |

Hot float is above the 10 USDC trigger, so no refill fires on its own.
**To exercise D1-TC-021, QA must drive the hot float below 10 USDC.** That is a
fixture step now, not an impossibility — before the cold reserve was funded it
could not be done at all.

Health currently reports USDC `warn` at 34 against a 50 threshold, XLM
`healthy`, overall `healthy: false`. That mixed state is what D1-TC-022 asks
for, and it survives the fixture payouts.

---

## 4. Fixtures and reset

Landed in [#86](https://github.com/webnxt-2030/Centient/issues/86) / PR #88.
Full detail in `docs/qa-fixtures-runbook.md`; the shape of it:

```bash
pnpm qa:fixtures seed      # create one run's fixtures
pnpm qa:fixtures status    # list recent runs
pnpm qa:fixtures reset     # remove the most recent un-reset run
pnpm qa:recipients:sponsor # mint the zero-XLM sponsored recipient, at TC-006
```

They refuse to run unless `STELLAR_NETWORK=testnet` is set **explicitly** —
unset is a refusal, not a default — and they are deliberately not part of
`pnpm db:seed`, which runs on every production deploy.

One run produces the six payout states and four recipient shapes the cases name.
The reset path obeys three rules: never rewrite a payout row carrying a
transaction hash, never reuse a payout reference, and record every reset with
what, when, and the SHA. Traceability survives a reset.

---

## 5. Evidence already captured

QA may cite these directly rather than re-deriving them.

| Check | Result |
| --- | --- |
| `POST /api/cron/wallet-health`, no auth | `401` |
| `POST /api/cron/wallet-health`, bearer secret | `200`, full wallet-health payload |
| Scheduled cron run, 2026-09-09T00:00:29Z | authenticated, complete, alert evaluated |
| `POST /api/cron/reserve-refill` | real plan state, not `unconfigured` |
| Alert delivered | `{"deliveries":[{"key":"wallet-usdc-warn","status":"sent"}]}` |
| Alert suppressed inside cooldown | `{"deliveries":[{"key":"wallet-usdc-warn","status":"suppressed"}]}` |
| Cooldown lease in Redis | `t2p:health-alert:wallet-usdc-warn`, TTL counting down |
| Co-signer role attributes | not superuser, no `CREATEROLE`, no `BYPASSRLS` |

### The co-signer's database role — D1-TC-016

Probed as `centient_cosigner` itself, every write attempt inside
`BEGIN … ROLLBACK` so a wrong grant could not have mutated anything:

```
reads the co-signer requires      SUCCEEDED  submissions, payout_jobs, 24h volume sum
reads it must not have            DENIED     users, admin_users        (42501)
writes to decision data           DENIED     UPDATE submissions.payoutStatus,
                                             UPDATE submissions.payoutTxHash,
                                             UPDATE payout_jobs.status,
                                             DELETE payout_jobs,
                                             INSERT payout_jobs        (42501)
grants held by the role           payout_jobs: SELECT · submissions: SELECT
```

`SELECT` on exactly the two tables it reads, and nothing else. That answers
TC-016 on its own terms.

### The deployed remote co-signer — D1-TC-013/014/015, deployed half of TC-004

Driven end to end through the deployed application, not through the gated local
signer:

| | |
| --- | --- |
| payout job | `eafabcdf-5e97-4dc8-b243-c3201434b5eb`, `WITHDRAWAL`, final status `done` |
| transaction | [`1791ca62…cad4`](https://stellar.expert/explorer/testnet/tx/1791ca62a1af09567de779be7db4ffdbbf2ffc7bbe411fe719fac791e7a6cad4) |
| ledger | 4577653, successful, 2026-09-08T23:57:32Z |
| operation | payment 5.0000000 USDC |
| signature 1 | ops signer `GAHZKJFA…HZ2U6` |
| signature 2 | policy signer `GCAUNAS2…KHIU` |

**Which process produced the policy signature.** `web` holds
`STELLAR_POLICY_SIGNER_PUBLIC` and not the secret, and
`assertAppDeploymentSeparation` refuses to start an app deployment holding both
`COSIGNER_URL` and the policy key. The signature could only have come from the
`cosigner` service.

**There is no co-signer log line to pair with the hash.**
`services/cosigner/server.ts` logs refusals only; a successful co-sign is
silent. The on-chain policy signature is accepted as the evidence instead
(D-04).

---

## 6. Running D1-TC-024

The route returns each alert's delivery outcome in its own response body. **Do
not scrape logs for this.**

```bash
curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://centient.work/api/cron/wallet-health | jq '{alerts, deliveries}'
```

`status` is `sent` on delivery and `suppressed` within the cooldown. The field
is **`deliveries`**, plural.

**Two traps.**

`HEALTH_ALERT_COOLDOWN_MS` is `1800000` (30 minutes) by standing decision
(D-02). TC-024 wants one delivery and then one suppression, so drop it to
`60000` **for that case alone** and restore it afterwards. A 60-second cooldown
left in place re-delivers the same USDC warning on every 5-minute check.

`instrumentation.ts` starts an in-process health monitor, so the application
raises and delivers these alerts on its own loop and holds the cooldown lease. A
manual call will usually return `suppressed` because the background loop got
there first. That is correct behaviour, not a defect — poll every few seconds
until the lease lapses rather than calling once and concluding delivery is
broken.

---

## 7. Decision register

Every decision a QA finding might otherwise re-litigate. **Settled means
settled** — record the behaviour, do not file it as a defect.

| ID | Decision | State |
| --- | --- | --- |
| D-01 | `COSIGNER_DAILY_CAP_UNITS` keeps its current value after the per-payout cap fix, even though the effective ceiling roughly doubles | **Settled** — testnet |
| D-02 | `HEALTH_ALERT_COOLDOWN_MS` stays at 30 minutes; TC-024 lowers it for that case only | **Settled** |
| D-03 | `cosigner` keeps its generic `DATABASE_URL`. It resolves to the same restricted `centient_cosigner` role, and removing it breaks `npx prisma generate` at build time because `prisma.config.ts` resolves `env("DATABASE_URL")` eagerly | **Settled** |
| D-04 | The on-chain policy signature is the evidence for the deployed co-signer path, in place of a success log line | **Settled** |
| D-05 | D1-TC-010 and TC-011 are evidenced by the automated ambiguity and recovery suites rather than by live fault injection | **Settled** — #86 |
| D-06 | Cold-reserve policy values (10 / 12 / 5 USDC) are a testnet policy | **Settled for testnet, open for mainnet** |
| D-07 | Seeded `admin@centient.work` and `demo@centient.work` credentials are accepted rather than rotated | **Settled** — ADR-0002, #87 |
| D-08 | The seeded admin serves QA; a read-only admin role is a mainnet follow-up | **Settled** |
| D-09 | Co-signer isolation is a separate service in the same Railway project/workspace/account, `COSIGNER_ISOLATION_LEVEL=same-workspace`, refused on the public network | **Settled** — ADR-0001 |
| D-10 | Postgres credential rotation was completed out of band and is not a QA case | **Settled** |
| D-11 | The frozen build moves forward rather than rolling back when QA-relevant work lands | **Settled** |
| D-12 | Secrets live in plain environment variables; there is no secrets-store integration | **Open for mainnet** |
| D-13 | `SEED_ON_DEPLOY` is enabled on `web`, so the seeder runs on every deploy and restores the demo balance | **Settled for testnet; must be off for mainnet** |
| D-14 | Exactly one payout submitter and one co-signer replica. The submit mutex, nonce store and in-flight commitments are process-local | **Settled — constraint, not enforced by config** |

### On the seeded credentials

`admin@centient.work` (`SUPER_ADMIN`) and `demo@centient.work` (a contributor
seeded holding 5 USDC of withdrawable balance) have passwords that are literals
in this repository, and the demo password is printed into the Railway deploy log
on every deploy. This is accepted for testnet QA under ADR-0002.

**What QA should do with it:** not file it as a defect — but if an unexplained
withdrawal or balance movement appears during the run, check this first, before
filing it as a payout defect. It is the one credential on the environment under
test that can move money on the rail.

---

## 8. Residual risks to carry into the QA record

Test what is here; do not overstate what it guarantees.

1. **Co-signer isolation is same-project.** A separate service in the same
   Railway project, workspace and account — not a separate trust domain
   (ADR-0001).
2. **The daily cap is a check, not a reservation.** Concurrent decisions can
   overshoot it.
3. **Cap-alert delivery is fire-and-forget**, with health monitoring as the
   backstop.
4. **There is a process-death window** around the in-memory transaction and
   envelope identity.
5. **The submit mutex is process-local**, which is why D-14 exists.
6. **The retry lease is deliberately conservative**, because `lastRetriedAt`
   cannot distinguish an in-flight retry from a recently completed failed one.

Sources: [#12](https://github.com/webnxt-2030/Centient/issues/12),
[#73](https://github.com/webnxt-2030/Centient/issues/73),
`docs/payments-lane-evidence.md`,
`docs/adr/0001-simulated-cosigner-isolation.md`,
`docs/adr/0002-seeded-credentials-accepted-on-testnet-qa.md`.

---

## 9. Before mainnet

Not QA gates. Carried here so they are not lost when Deliverable 1 closes.

- Re-decide the cold-reserve policy values against real float (D-06).
- Move signer secrets into a secrets store (D-12).
- Disable `SEED_ON_DEPLOY` and remove the seeded accounts (D-13, D-07).
- Add the read-only admin role (D-08).
- Re-decide `COSIGNER_DAILY_CAP_UNITS` against a real ceiling (D-01).
- Move the co-signer to its own Railway account or provider (D-09, ADR-0001).
- Rotate the QA Discord webhook once the run is finished.

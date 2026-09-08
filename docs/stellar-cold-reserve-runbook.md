# Stellar cold-reserve refill runbook

Issue #10 separates the always-online payout wallet from the bulk USDC reserve.
The hot wallet holds only a bounded operating float. The cold reserve is a
separate native Stellar 2-of-3 account, and a refill is accepted only when two
of its three configured identities sign the exact cold-to-hot transaction.

## Security boundary

The deployed application stores these cold values only:

- cold account public key;
- ops and policy co-signer public keys;
- refill trigger, target, and minimum retained USDC units.

It stores no cold seed. The scheduler only reports that a refill is required.
Each custodian runs the `sign` command on isolated infrastructure with exactly
one seed, the public policy, and the separately approved exact amount. Signing
does not contact Horizon. The custodian then removes the seed from the process
environment. The keyless
submit command rechecks the current balances, transaction shape, amount, time
bounds, fee, and every signature before one Horizon submission.

The three allowed signing identities are the cold account master, cold ops, and
cold policy keys. Each has weight 1; low, medium, and high thresholds are 2.
Any two can refill, but no single key can move reserve funds.

## Required configuration

All values refer to the active `STELLAR_NETWORK` and
`STELLAR_USDC_ISSUER`. One USDC is `10000000` units.

```dotenv
STELLAR_COLD_RESERVE_ACCOUNT=G_cold_master_public_key
STELLAR_COLD_OPS_SIGNER_PUBLIC=G_cold_ops_public_key
STELLAR_COLD_POLICY_SIGNER_PUBLIC=G_cold_policy_public_key
STELLAR_PLATFORM_ACCOUNT=G_platform_hot_wallet_public_key
STELLAR_HOT_FLOAT_TRIGGER_UNITS=250000000
STELLAR_HOT_FLOAT_TARGET_UNITS=1000000000
STELLAR_COLD_MIN_RETAIN_UNITS=500000000
```

The example policy triggers at 25 USDC, restores exactly 100 USDC, and refuses
any refill that would leave less than 50 USDC cold. Set values from the measured
daily payout budget.

### Worst-case loss

A complete hot-wallet compromise can spend at most what the hot wallet holds,
and the hot wallet never holds more than the refill target, because every
refill restores *exactly* the target and nothing else deposits into it. The
cold reserve is untouched: no deployed service holds a cold seed, and a
refill needs two of the three cold signers. So the bound is the target, not
the reserve.

| Quantity | Source | Example policy |
|---|---|---|
| Hot float target | `STELLAR_HOT_FLOAT_TARGET_UNITS` | 100 USDC |
| Daily payout cap | `DAILY_PAYOUT_CAP_UNITS` | set ≤ target so one day's payouts cannot outrun the float |
| Measured daily payout budget | `getPayoutActivitySince` over the trailing 7 days, or the admin status page | fill in before choosing the target |
| **Worst-case loss** | = hot float target | **100 USDC** |
| Cold balance at risk | none | 0 USDC |

Choose the target as a small multiple of the measured daily budget (two to three
days covers a weekend without a refill ceremony). Raising the target raises the
worst-case loss one-for-one; that trade is the only policy decision here, and it
is re-made whenever the daily budget changes materially.

The cold account also needs XLM for its base reserve, USDC trustline, and rare
refill fees. Keep at least 5 XLM spendable above its ledger reserve. The refill
transaction pays its own fee and refuses a total fee over 10,000 stroops.

The deployed payout service may derive the same hot account from
`STELLAR_PLATFORM_SECRET`. When public account and secret are both configured,
startup fails if they disagree. Offline custodians configure only the public
account and never receive the hot seed.

## Provision a testnet cold reserve

Generate the master, ops, and policy keys on separate trusted systems. Move
each seed directly into its custodian's secret manager. Exchange only the three
public keys. For a disposable testnet proof, the setup command can generate and
print throwaway keys only when `STELLAR_ALLOW_TESTNET_KEY_GENERATION=true` is
explicitly set; copy them immediately and never commit its output. That switch
is rejected on the public network. Production setup fails closed unless the
master seed and both pre-provisioned signer public keys are supplied.

Initial setup requires the master seed only long enough to create the USDC
trustline and install the 2/2/2 threshold policy:

```bash
STELLAR_NETWORK=testnet \
STELLAR_COLD_RESERVE_SECRET='<master seed from secure injection>' \
STELLAR_COLD_OPS_SIGNER_PUBLIC='G…' \
STELLAR_COLD_POLICY_SIGNER_PUBLIC='G…' \
STELLAR_PLATFORM_ACCOUNT='G…' \
STELLAR_USDC_ISSUER='GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' \
npm run stellar:reserve:setup
```

On testnet, a missing cold account is friendbot-funded. The script establishes
the configured USDC trustline before raising thresholds, configures master/ops/
policy at weight 1, verifies 2/2/2 through Horizon, and prints public explorer
links. It verifies the cold seed matches any configured cold public key and
rejects a cold account that matches the configured hot wallet before making a
network call. On public network it never funds an account or generates keys
automatically.

If the account already has any active signer outside the intended master, ops,
and policy keys, setup aborts before creating a trustline or changing
thresholds. Remove that signer only through an explicitly authorized manual
recovery signed under the account's current policy, then rerun setup.

After setup:

1. Verify the three public keys and thresholds on stellar.expert.
2. Fund the cold XLM floor.
3. Send USDC to the cold account through the Circle testnet faucet or an
   approved treasury transfer.
4. Fund the hot account with no more than its target float.
5. Remove `STELLAR_COLD_RESERVE_SECRET` from the setup environment.

Once the thresholds are installed, key rotation needs any two current
custodians. Do not expect the setup script's single master signature to rotate
an already secured account.

## Scheduled detection

Call the authenticated endpoint on the chosen schedule (hourly is sufficient
for the initial operating float):

```text
POST /api/cron/reserve-refill
Authorization: Bearer <CRON_SECRET>
```

Responses:

- `200 healthy`: hot USDC is above the trigger.
- `202 refill_required`: custodians must execute the exact `amountUnits`.
- `503 insufficient_reserve`: no transaction is proposed; replenish or revise
  the policy through an approved configuration change.
- `500`: configuration or Horizon failed; inspect server logs and do not guess
  an amount.

The cron does not generate XDR. A refill XDR expires after 15 minutes, so an
unattended scheduler must not create competing stale envelopes.

## Wallet-health schedule and authenticated check

Wallet health is checked by the authenticated `POST /api/cron/wallet-health`
endpoint. **Nothing in this repository schedules it** — `railway.json` only
runs migrations before deploy, and the same is true of `/api/cron/payout-retry`
and `/api/cron/reserve-refill`. Provision a scheduler outside the app (a Railway
cron service or equivalent) with `CRON_SECRET` in its own secret store and
invoke it at least once per minute in production so short-lived balance and
activity breaches are observed promptly:

```bash
curl -X POST https://APP_HOST/api/cron/wallet-health \
  -H "Authorization: Bearer $CRON_SECRET"
```

The response contains the current USDC and spendable XLM status, payout and
failure metrics, reserve state, configured thresholds, and alert delivery
results. A `sent` result means Discord accepted the alert; `suppressed` means
the alert identity is inside its cooldown window. Every identity shares one
cooldown, `HEALTH_ALERT_COOLDOWN_MS` (default 15 minutes). That includes
`payout-cap`, which before #72 had its own 60-minute cooldown in the payout
path; the shorter, shared window is deliberate, because the payout path and the
health monitor raise the same identity through one Redis lease and must agree
on its length. Alert identities include
`wallet-usdc-warn`, `wallet-usdc-page`, `wallet-xlm-warn`,
`wallet-xlm-page`, `payout-rate-spike`, `payout-volume-spike`, `payout-cap`,
`repeated-payout-failures`, `reserve-refill-overdue`,
`payout-monitoring-unavailable`, `reserve-monitoring-unconfigured`,
`reserve-monitoring-unavailable`, and `refill-timer-unavailable`.

## Rollout order: migrate before deploying the application

`prisma/migrations/20260908090000_add_payout_broadcast_monitoring` adds the
`PayoutJob.broadcastAt` column and the indexes the monitor queries. Apply it
**before** the application that reads it:

1. `npx prisma migrate deploy` against the target database.
2. Deploy the application build (`prisma generate` runs as part of `npm run build`).
3. Only then enable or resume the `POST /api/cron/wallet-health` schedule.

Deploying first makes every payout-activity, cap, and anomaly query fail against
the old table; the monitor reports those sources as `error` and pages rather
than reporting false zeros, but the rollout is still wrong in that order. The
migration is additive, so an application deployed before it is applied recovers
as soon as the migration lands — no rollback of the migration is required.

Its two indexes are built with `CREATE INDEX CONCURRENTLY` so the payout worker
can keep claiming jobs and writing heartbeats to `payout_jobs` while the
migration runs. A concurrent build that fails leaves an **invalid** index
behind, and the re-run then fails with "already exists". Check and clean up
before re-running:

```sql
SELECT indexrelid::regclass AS index, indisvalid
FROM pg_index WHERE indrelid = 'payout_jobs'::regclass AND NOT indisvalid;

DROP INDEX CONCURRENTLY "payout_jobs_broadcastAt_idx";
DROP INDEX CONCURRENTLY "payout_jobs_status_completedAt_idx";
```

## Alert delivery results and what they mean

Every alert result in the cron response is one of:

| Result | Meaning | Operator action |
|---|---|---|
| `sent` | Discord accepted the alert and Redis holds the cooldown. | None. |
| `suppressed` | The alert identity is inside its Redis cooldown window. | None. |
| `sent-degraded` | Discord accepted the alert, but Redis could not lease or extend the cooldown. Deduplication for this identity is process-local only. | Check Redis; expect repeats across processes while it is down. |
| `suppressed-degraded` | A concurrent or recent delivery in this process already covered the identity while Redis was unavailable. | Check Redis. |
| `failed` | Discord did not accept the alert, or a WARN alert could not be deduplicated safely. | Treat the underlying condition as unnotified and check it directly. |
| `disabled` | `DISCORD_WEBHOOK_URL` is unset. | Configure the webhook before relying on alerting. |

Delivery logs deliberately record only an error's class, an HTTP status, and the
alert identity. Webhook URLs, seeds, and full error messages are never logged.

## Redis failure policy

Redis backs alert deduplication and the reserve refill-due timer. It is never
the source of truth for money.

- Every Redis call the health path makes is bounded by
  `REDIS_OPERATION_TIMEOUT_MS` (2000 ms by default). A command that lands after
  its deadline is abandoned. The Horizon reads are bounded the same way by
  `STELLAR_HORIZON_TIMEOUT_MS` (10000 ms by default) — the Stellar SDK itself
  waits forever, so a stalled Horizon would otherwise hang the whole check.
- **PAGE** alerts still deliver when Redis is unavailable, deduplicated within
  the process, and report `sent-degraded` / `suppressed-degraded`. A PAGE is
  never dropped because Redis is down.
- **WARN** alerts fail closed (`failed`) when Redis is unavailable, so a warning
  storm cannot be amplified across processes.
- The refill-due timer refuses to issue a new set/get/delete while an earlier
  command has not settled, and reports `refillTimer: "error"` until it does.
  `refill-timer-unavailable` pages; `refillDueSince` stays `null` rather than
  resetting the clock.
- Restarting Redis clears cooldowns, so a still-active breach may re-page once.

## Complete alert identity list

Balance and rail conditions:

`wallet-usdc-warn`, `wallet-usdc-page`, `wallet-xlm-warn`, `wallet-xlm-page`,
`payout-rate-spike`, `payout-volume-spike`, `payout-cap`,
`repeated-payout-failures`, `reserve-refill-overdue`.

Monitoring-source and top-level failures (these say the check itself could not
run — never read a missing metric as healthy):

| Identity | Severity | Meaning |
|---|---|---|
| `wallet-monitoring-unconfigured` | WARN | `STELLAR_PLATFORM_SECRET` or the USDC asset is not configured. |
| `wallet-monitoring-unavailable` | PAGE | Horizon account/ledger lookup failed; balances and reserve counts are `null`. |
| `payout-monitoring-unavailable` | PAGE | Payout activity, cap spend, or failure counts could not be queried. |
| `reserve-monitoring-unconfigured` | WARN | The cold reserve policy is not configured. |
| `reserve-monitoring-unavailable` | PAGE | Hot and cold reserve balances could not be loaded. |
| `refill-timer-unavailable` | PAGE | The refill-due timer could not be read or written. |
| `health-monitor-unavailable` | PAGE | The snapshot itself could not be assembled. |
| `payout-persistence-unavailable` | PAGE | A payment was accepted on-chain but its broadcast tuple or bookkeeping could not be recorded. **Reconcile the transaction hash before any refund or reissue** — the payout already left the wallet. |

A malformed optional balance threshold is a configuration error, not an
outage: the affected threshold falls back to its documented default, a warning
is logged, and Horizon monitoring stays live.

## Test-environment alert simulations

Run these checks only against a disposable Stellar testnet wallet and a test
Discord webhook. Use secret-manager injection for `CRON_SECRET` and the
platform seed; do not place either value in a command, commit, or evidence
record. Restore the original thresholds and balances after each simulation.

1. **Low USDC:** fund the test platform account, then transfer enough USDC
   away that its float is below `BALANCE_PAGE_USDC` (10 USDC in the example
   configuration). Run the authenticated request above and verify
   `wallet-usdc-page` is present with `PAGE` severity.
2. **Low spendable XLM:** leave the account funded enough to query Horizon but
   reduce spendable XLM (after ledger reserve, liabilities, and sponsored
   reserves) below `BALANCE_PAGE_XLM` (2 XLM). Run the request and verify
   `wallet-xlm-page` is present with `PAGE` severity. Check the reported
   spendable amount, not the gross XLM balance.
3. **Anomaly threshold:** first set a high, test-only threshold (for example,
   `HEALTH_PAYOUT_COUNT_THRESHOLD=100000`) and set
   `HEALTH_PAYOUT_WINDOW_MINUTES` longer than the activity interval. Create at
   least two successful test payouts, run the request, and record the observed
   payout count `N` from its metrics (confirm `N >= 2`). Then set the threshold
   below that already observed activity, such as
   `HEALTH_PAYOUT_COUNT_THRESHOLD=N-1`, run the request again, and verify the
   `payout-rate-spike` identity and the same observed count are reported. Do
   not lower production thresholds as part of this test.
4. **Cooldown suppression:** keep one breach active, run the request once and
   verify its alert is delivered, then repeat the same request within
   `HEALTH_ALERT_COOLDOWN_MS` (900000 ms by default). Verify the second result
   is `suppressed` and no duplicate Discord notification is emitted. After the
   cooldown, a still-active breach may be delivered again.

Record only the test network, public account, observed status, alert identity,
delivery result, and timestamps. Never record webhook URLs, secrets, private
keys, or real production endpoints.

## Prepare the exact refill

On an online operator host with public policy configuration and Horizon access:

```bash
npm run stellar:reserve:refill -- status
npm run stellar:reserve:refill -- prepare
```

`prepare` only succeeds for `refill_required`. Confirm the printed cold account,
hot account, exact USDC amount, hash, and explorer URL. Copy the
`STELLAR_RESERVE_REFILL_XDR=…` value through the approved secure channel. The
XDR contains no secret, but an unsubmitted signed XDR is approval material and
must not be committed or posted publicly.

## Collect two independent signatures

Custodian A runs, using secret-manager injection rather than a literal shell
history entry:

```bash
STELLAR_RESERVE_REFILL_XDR='<prepared XDR>' \
STELLAR_RESERVE_REFILL_AMOUNT_UNITS='<approved amountUnits>' \
STELLAR_COLD_SIGNER_SECRET='<one custodian seed from secure injection>' \
npm run stellar:reserve:refill -- sign
```

Custodian A passes only the resulting XDR to custodian B. Custodian B repeats
the same command with B's own seed and the partially signed XDR. A signer must
be one of master, ops, or policy, and the command refuses the same key twice.
No process invocation may contain two cold seeds.

The signing host needs no network access. Transfer `amountUnits` independently
from the XDR (for example, from the authenticated cron response) and compare it
to the approved request before setting `STELLAR_RESERVE_REFILL_AMOUNT_UNITS`.

Both custodians independently compare the printed source, destination, amount,
asset issuer, fee, expiry, and hash to the approved request before signing.

## Submit once

Return the twice-signed XDR to the online operator host:

```bash
STELLAR_RESERVE_REFILL_AMOUNT_UNITS=<amount from prepare> \
STELLAR_RESERVE_REFILL_XDR='<twice-signed XDR>' \
npm run stellar:reserve:refill -- submit
```

Pass the same `STELLAR_RESERVE_REFILL_AMOUNT_UNITS` the custodians signed
against. It is optional, but without it the amount check at submit reads the
amount from the envelope and compares it with itself; with it, an envelope
carrying any other amount is refused before Horizon is contacted.

Immediately before submission, the command reloads hot and cold balances and
re-checks both policy invariants against the exact amount the custodians
signed: the refill must not raise the hot float above its target, and must not
pull the cold reserve below its retained floor. It rejects extra operations,
operation-level source overrides, a different source, destination, asset,
issuer, an amount above the target, fee above 10,000 stroops, a future start,
an expiry more than 15 minutes away, missing/expired time bounds, unconfigured
signatures, duplicate identities, or fewer than two valid signatures.

The signed amount is deliberately *not* required to equal a freshly derived
`target - hot`. The hot wallet keeps paying out during the signing ceremony, so
re-deriving the amount at submission would invalidate both custodian signatures
on every payout and leave the refill unable to complete under exactly the load
that triggered it. A refill that has become smaller than the current shortfall
is still a valid partial top-up, and refills therefore do not require freezing
payouts.

Note what a partial top-up leaves behind. `planReserveRefill` reports `healthy`
for any hot balance above the trigger, so a top-up that lands between the
trigger and the target is not re-requested: the scheduled check goes quiet
until the float next falls to the trigger, and the wallet operates slightly
below target in the meantime. That is the intended trigger-based behaviour, not
a missed refill — the float stays bounded by the target either way. Raise the
trigger if you need the working float held closer to it.

The signed hash and explorer link print before Horizon is called. The command
submits once and never retries automatically.

## Unknown submission outcome

If the connection drops or Horizon times out after the hash prints:

1. Do not submit the XDR again.
2. Search the printed hash on Horizon or stellar.expert.
3. If it succeeded, verify both balance deltas and record the hash.
4. If it is absent after the transaction expires, run `status` and prepare a
   fresh transaction from the new on-chain sequence.
5. If status cannot be established, freeze refills and escalate. Never create a
   second approval based on an assumed failure.

Stellar sequence numbers prevent the same successful envelope from executing
twice, while the short time bound limits an unsubmitted approval's lifetime.

## Emergency stop and recovery

For a suspected hot compromise, wrong policy, or custodian incident:

1. Disable the external reserve-refill cron schedule.
2. Stop preparing and submitting refill XDRs.
3. Preserve the last printed hash and reconcile it on-chain.
4. Rotate affected cold signers with two known-good current custodians.
5. Move cold funds to a newly provisioned 2-of-3 account if two identities may
   be compromised.
6. Rotate the hot signing set separately and lower the configured target before
   resuming.
7. Re-enable the scheduler only after public keys, thresholds, balances, and
   configuration have been reviewed by two people.

For `insufficient_reserve`, do not lower the retain floor merely to make the
job green. Replenish cold funds or approve a policy change with an explicit
updated worst-case calculation.

## Public evidence record

Record only public facts after the live testnet proof:

```text
Network:
Cold account:
Cold ops public key:
Cold policy public key:
Thresholds and weights:
Trustline transaction hash:
Multisig setup transaction hash:
Refill transaction hash:
Hot USDC before -> after:
Cold USDC before -> after:
Trigger / target / retained floor:
stellar.expert account and transaction links:
```

Never record a seed, secret-manager reference, or signed XDR.

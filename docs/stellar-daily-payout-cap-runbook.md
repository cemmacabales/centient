# Daily payout cap runbook

The Daily Cap bounds the USDC that can leave the payout account. It is enforced
independently by the payout service and the policy co-signer, using two variables
and two ledger reads. A bypass or misconfiguration at either process must still
leave the other process able to refuse the payout.

This runbook is for the current testnet deployment. The same-workspace isolation
level is refused on Stellar public/mainnet independently of these limits.

## Units and recommended value

All values are integer Stellar USDC units. One USDC is `10000000` units, so:

```text
cap units = USDC amount × 10000000
100 USDC = 1000000000 units
```

Do not add decimal points, commas, or an XLM stroop value. The recommended
100-USDC example is `1000000000`. If policy requires 200 USDC, its correct
conversion is `2000000000`, not `200000000000` (which is 20,000 USDC).

## The two independent gates

| Process | Variable | Window | Disabled value | Spend source |
| --- | --- | --- | --- | --- |
| Payout service (`web`) | `DAILY_PAYOUT_CAP_UNITS` | trailing/rolling 24 hours | `0` | payout jobs with a transaction hash, amount, and `broadcastAt` in the window |
| Policy co-signer (`cosigner`) | `COSIGNER_DAILY_CAP_UNITS` | current UTC calendar day, since 00:00 UTC | none; it must be a positive integer | its read-only ledger view, plus signatures issued but not yet visible as broadcasts |

The variables must be configured separately. The co-signer deliberately does not
fall back to `DAILY_PAYOUT_CAP_UNITS`, and the application does not read
`COSIGNER_DAILY_CAP_UNITS`. Using the same numeric target is reasonable, but it
must still be written to both services as two independent settings.

### Window divergence

The windows are intentionally documented as different, not silently treated as
equivalent. At 00:30 UTC, for example, the co-signer counts only payouts since
midnight while the application still counts broadcasts from the preceding 23.5
hours. Either process may therefore refuse a payout that the other would allow.
That is fail-closed behavior: a payout settles only when both windows have room.

Do not unify the windows as part of an operational cap change. Changing either
window is a design change and needs its own issue and review.

## Set or change the cap

1. Choose the maximum USDC exposure and convert it to units with the formula
   above. Keep the cap at or below the permitted hot-wallet Float.
2. In Railway's `centient-work` project, set `DAILY_PAYOUT_CAP_UNITS` on the
   `web` service.
3. Separately set `COSIGNER_DAILY_CAP_UNITS` on the `cosigner` service. Never
   copy it through a shared/reference variable and never put the policy signing
   seed on `web`.
4. Read both service configurations back and confirm the exact integer value.
   Cap values are not secrets, but avoid commands that print the rest of the
   environment: never run `railway environment config --json` unfiltered.
5. Redeploy both services so their running containers receive the new values.
   A variable write made with `--skip-deploys` does not change a running process.
6. Confirm `web` starts its payout worker and `cosigner` reports healthy with
   one replica. Do not scale the co-signer above one replica: replay nonces and
   in-flight cap commitments are process-local.

`DAILY_PAYOUT_CAP_UNITS=0` disables only the application's limit. Use it solely
for an explicit test or incident decision after confirming the co-signer gate is
healthy. `COSIGNER_DAILY_CAP_UNITS=0` is invalid and the co-signer will refuse to
start.

## Breach behavior

The payout service checks its rolling window before resolving the co-signer or
constructing a transaction. On breach it throws `PayoutCapError` and runs the cap
alert path. What happens to the job then depends on its type, and the two differ:

- A **withdrawal** — the live earnings path — is **terminal**. Its retry budget is
  consumed and the user's locked balance is refunded, so the money returns to
  their withdrawable balance and they can re-withdraw once the window has room.
  Nothing retries it on their behalf.
- A legacy **per-submission** payout is **deferred**. The submission stays
  `pending`, its retry budget is untouched, and its campaign debit stays reserved
  so the later attempt has funding. This path only drains `SUBMISSION_PAYOUT`
  jobs enqueued before the accrual cutover — new earnings accrue to the user's
  balance at submit time and settle as a withdrawal, so a cap breach today
  reaches the withdrawal behavior above.

The deferral is **not self-healing on its own**. Recovery runs through
`POST /api/cron/payout-retry`, which is scheduled outside the application (see
the [cold-reserve runbook](stellar-cold-reserve-runbook.md) for how the other
crons are provisioned). If that schedule is not running, a deferred submission
never retries and its campaign debit stays reserved indefinitely. Confirm the
schedule before treating a `pending` payout as merely waiting.

The policy co-signer checks its UTC-day spend before signing. On breach it returns
HTTP 409 and no detached signature, so the two-signature payout cannot be
submitted, whatever the application decided.

The cap alert reports the **ledger's** spend, not the refused amount: a paging
alert can read below 100% consumed and still carry a `blocked attempt: N units`
line. That is the refusal, not an arithmetic error — the units in that line never
left the payout account.

An operator should verify the recorded broadcast volume and the two configured
values. Do not requeue or raise a cap merely to clear a pending payout.

## Regression checks

Run the focused independence tests after changing cap behavior or configuration:

```bash
pnpm vitest run \
  lib/__tests__/payout-cap.test.ts \
  lib/stellar/__tests__/cosigner-service.test.ts
```

The required proof runs in both directions:

- with `DAILY_PAYOUT_CAP_UNITS=0`, an over-cap request is still refused by the
  co-signer;
- with a generous co-signer cap, an over-cap request is still refused by the
  payout service.

See also the [co-signer deployment runbook](cosigner-deployment.md) for service
separation and read-only-database probes, and the
[payout failure runbook](stellar-payout-failure-runbook.md) for incident handling.

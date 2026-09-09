# Payments-lane evidence — Deliverable 1

**Issue:** [#12](https://github.com/webnxt-2030/Centient/issues/12) · **Epic:** [#4](https://github.com/webnxt-2030/Centient/issues/4) · **Network:** testnet only

This is the document Deliverable 1 points at for the claim *"no single-key payout
path exists anywhere in the codebase."* It records what is machine-checked, how,
and — in equal detail — what is not.

---

## The claim, and what enforces it

The guarantee is not "we removed `payUsdc`." It is that **no code path can
broadcast a payout carrying fewer than two independent, verified signatures**,
and that a path reintroducing one fails CI rather than shipping.

Three earlier guards each proved something narrower:

| Guard | What it catches | What it misses |
| --- | --- | --- |
| Absence-of-export tests (`client.test.ts`, `payout-usdc.test.ts`) | A re-export of the retired `payUsdc` | A new single-key path written under a different name |
| Per-module signature assertions (`payout-envelope.test.ts`, `payout-submitter.test.ts`) | An envelope built by *this* submitter reaching Horizon under-signed | Code that never goes through this submitter |
| `assertPayoutFullySigned` | One key counted twice, a signature over another envelope | Nothing calling it |

None fails if a `server().submitTransaction(...)` on a singly signed envelope
appears in a file created tomorrow. That is the gap `#7` explicitly deferred
(`docs/stellar-multisig-payout-service.md`) and this issue closes.

### The guard, in two halves

`lib/stellar/__tests__/no-single-key-payout.test.ts` holds both halves, because
each alone is bypassable:

1. **Structural.** Scan `lib/`, `app/`, `services/` and `scripts/` and assert
   that the set of Horizon submit sites, USDC payment builders, and readers of
   the platform signing secret each equals a named allowlist with a stated reason
   per entry. `scripts/` is in scope on purpose — "anywhere in the codebase" is
   not satisfied by a library that behaves while a hand-run script beside it does
   not. Submits are matched as a *member reference*, not as a call, so an alias
   (`server().submitTransaction.bind(...)`), a destructure, or a callback cannot
   walk past a call-shaped pattern. Known limit: a raw `fetch` to Horizon's
   `/transactions` endpoint bypasses the SDK and this pattern — the
   payment-builder and signing-secret checks are what stand in its way, since a
   payout that is never built and can never be platform-signed cannot be
   broadcast by any transport.
2. **Boundary.** `submitMultisigPayout` refuses anything not carrying two
   distinct verified signatures — on the fee bump as well as the inner payment,
   against a co-signature that is genuinely the right key's but over a different
   envelope, and against a co-signer that signs the payment stage then fails the
   fee-bump stage.

A structural-only guard stays green if `assertPayoutFullySigned` is weakened. A
boundary-only guard is blind to a new direct caller of Horizon. Together they
close the path.

The allowlist is pinned in **both** directions: an unlisted submit site fails,
and a listed path that has vanished or stopped submitting fails too. An entry is
a promise about one specific file; a stale entry would otherwise become a blanket
exemption for whatever occupies that path next. When this test fails after a
refactor, the fix is to move the entry **and re-justify it**, never to widen the
pattern.

**Verified by injection**, not by inspection: a probe module submitting a singly
signed USDC payment was added to `lib/stellar/`, and both structural cases failed
and named the file. The allowlist's reverse direction also caught two mistakes in
its own first draft.

---

## Definition of Done

| DoD line | Evidence |
| --- | --- |
| Payments-lane suite green in CI, run link captured | `payments-lane` job in `.github/workflows/ci.yml` — 52 files, 690 tests. Run link recorded on the PR. |
| A test asserts no single-key payout path and fails if one is introduced | `lib/stellar/__tests__/no-single-key-payout.test.ts`, both halves, injection-verified |
| Cap enforcement and signing paths covered | `lib/__tests__/payout-cap.test.ts`, `lib/stellar/__tests__/cosigner-service.test.ts` (both directions, from #9); `payout-envelope.test.ts`, `payout-submitter.test.ts` |
| Concurrency test shows zero double-pays under load | `lib/__tests__/payout-concurrency-db.test.ts` |
| Cap alert evaluated only after the broadcast tuple is persisted | `lib/__tests__/payout-cap-alert-ordering-db.test.ts`, proven by what the alert *reports*, not by timing |

### Why the CI lane is a named job

`build` already ran these tests inside the full suite, so "the payments lane is
green" was technically true before this issue and worthless as evidence: a link
to `build` says *every test in the repository passed*, which is not a statement
about the payment rail and stops being one the moment an unrelated suite goes
red. A named job fails on its own and is linkable on its own.

The cost — a second Postgres service and a duplicated install/migrate per PR —
was weighed and accepted. `build` remains the authoritative merge gate and still
runs everything the lane runs. Which checks branch protection *requires* is a
repository setting, not part of this change.

Lane membership is defined once in `tests/payments-lane.ts`, shared by the CI
config and the guard so the two cannot disagree about what the lane is, and every
glob is asserted to match at least one file — a glob matching nothing would
shrink the lane while leaving the job green.

---

## Residual risks

**These are not caveats appended for completeness. Each one is a way the rail can
still lose money or fail to warn, and the evidence is incomplete without them.**

### 1. The co-signer's isolation is simulated, at the server boundary only

Recorded in [ADR-0001](adr/0001-simulated-cosigner-isolation.md). The policy
co-signer runs in its own Railway service inside the **same** workspace, account,
control plane, repository, CI pipeline, and database instance as the application
it is supposed to be independent of.

In SOW §3.8's terms this satisfies *server* isolation and **not** *account*
isolation. An attacker who compromises the Railway account, the repository, or
CI reaches both signers — the exact single point of failure the 2-of-3 exists to
remove. What it does buy is real: separate container, service-scoped variables,
separate deploy trigger and member list, HMAC-authenticated transport, and a
read-only Postgres role for ledger re-derivation.

The limit is machine-checked rather than promised:
`COSIGNER_ISOLATION_LEVEL=same-workspace` **fails closed** when
`STELLAR_NETWORK=public` (`lib/stellar/cosigner-isolation.ts`), and the level is
never assumed — an unset value refuses to boot. Mainnet therefore requires the
separate account; promoting to it is a deployment change with no service-code
change.

**Accepted because** the rail is pre-mainnet and the value at risk is zero. This
risk becomes a blocker at mainnet cutover, not before.

### 2. The cap alert's ordering defect — fixed in this issue

Carried forward from #9, which merged knowingly at `2aa807d`. `maybeSendCapAlert()`
fired from inside `payReward`, before any caller had written the payout's
`(txHash, amountUnits, broadcastAt)` tuple, so the alert's own rolling-24h read
could miss the payout that had just settled and skip a threshold crossing
entirely.

**Status: fixed here.** The amountless call now runs at the three sites that
persist the tuple — `processWithdrawalJob`, `processSubmissionPayout`, and
`reprocessPayoutWithNonceSafety` — each immediately after `persistAcceptedPayment`
reports success. The regression test controls read/write ordering rather than
measuring it, and was confirmed to fail against the preceding commit.

The rejected alternative is worth recording: passing the amount into the alert
trades a missed alert for a **double-count**, because the read may or may not
already see the tuple. `buildPayoutCapAlert`'s `blockedAttemptUnits` parameter is
untouched — it exists so a *refused* payout raises the alarm without being
reported as spent, and `lib/health-monitor.ts` depends on the zero-argument
behavior.

**Remaining exposure:** the alert is fire-and-forget at all three sites, so a
Redis or Discord failure still loses that individual alert. The health monitor
raises the same alert identity from the same ledger, which is the backstop.

### 3. The daily cap is a check, not a reservation

`lib/payout-cap.ts` reads the rolling 24-hour total and authorizes one payout
against it. It takes no reservation, so **concurrent payouts can each pass the
cap and together exceed it.** This is asserted as behavior in
`lib/__tests__/payout-concurrency-db.test.ts`, deliberately: keeping the
trade-off machine-checked means it cannot drift out of this document, and if the
cap ever becomes a reservation that case fails and the risk is removed on
purpose rather than by accident.

The overshoot is bounded by the cap alert — which is precisely why risk 2
mattered, and why the two are recorded together rather than separately.

**Not at risk here:** no payout settles twice. Every payout in the overshoot is a
distinct payout the cap individually authorized.

---

## Two further limits, outside this issue's scope but load-bearing

Neither is new, and neither is closed by anything above.

- **The process-death window.** The envelope hash lives in memory for the
  duration of the submit call. A crash between submit and resolution loses it,
  and the job requeues without it. Closing this needs the hash persisted before
  submit and reconciled before reissue — a payout state-machine change tracked on
  the roadmap. `lib/payout-service.ts`'s retry claim now holds a lease *and*
  refreshes it while the broadcast is in flight, which narrows the window in
  which a slow submit loses a claim it still holds — but does not close it. Every
  claimant honours the lease: the cron stands down on a live one, and the admin
  retry route refuses with a 409 rather than resetting a lease it does not own,
  both reading the single `retryClaimIsLive` definition. The
  refresh is a best-effort write whose failures are swallowed so they can never
  turn into a payment failure, and a stalled event loop delays it, so a
  sufficiently degraded process can still be reclaimed mid-payout. **This is a
  lease, not a fence.** Process death is the case it cannot help with at all:
  refreshes stop, the lease expires, and the row is reclaimed without the
  envelope hash the first attempt never persisted. The failure runbook routes
  that case through reconciliation rather than implying a bare retry is safe.
- **The submit lock is process-local.** `submitMultisigPayout`'s sequence mutex
  serializes payouts inside one Node process and nothing beyond it, so the
  deployment must run exactly one payout submitter. A second instance costs
  throughput rather than correctness (`tx_bad_seq` → one rebuild → requeue), but
  scaling this path horizontally needs a distributed lock. Documented at the mutex
  and in the payout runbook; owned by #50's mainnet preflight.

---

## Reproducing this locally

```bash
npm run test:payments   # the lane exactly as CI runs it
npm run typecheck       # tsc --noEmit; there is no ESLint or Prettier gate
```

`npm`, not `pnpm`, because `npm ci` against the committed `package-lock.json` is
the install authority for CI. The `pnpm` aliases work locally and resolve the
same tree today, but only the npm form reproduces what the lane actually ran.

# D1-TC-010 and D1-TC-011 — proposed evidence path

**Status: a recommendation for [#80](https://github.com/webnxt-2030/Centient/issues/80) to accept or reject on the record.**
This is B4 on [#86](https://github.com/webnxt-2030/Centient/issues/86). It is not a decision already taken.

## What is being asked

Both cases require inducing a failure the deployed system has no control for:

- **TC-010** — "Test environment can induce timeout/unknown response after submit or equivalent ambiguity."
- **TC-011** — "Controlled failure can be induced after Stellar accepts a transaction but before/while local persistence completes."

The readiness guide offers two exits: ship a fault-injection control, or have #80
accept named automated tests as the evidence path.

## Recommendation: accept the automated path, and do not build the control

The control would have to sit in the production submit path, because that is the
path under test. Even gated to testnet it is a branch that exists in the deployed
binary, reachable if the gate is ever misconfigured — and the gate is exactly the
kind of thing that gets misconfigured, as the environment work on #85 showed more
than once. The guide's own standard in section 7 is that a testnet-only hook
reachable on mainnet is worse than the coverage gap it closes. That standard
applies here.

The invariants the two cases exist to check are already asserted, against a real
database in the concurrency suite rather than only against mocks.

## TC-010 — ambiguous submit is reconciled before retry

| Case step | Assertion |
| --- | --- |
| 2. Do not rebuild or blindly resend | `payout-submitter.test.ts` — *does not rebuild when the submit outcome is ambiguous* |
| 3–4. Resolve the original transaction by its identity | *resolves an ambiguous submit that actually settled by its envelope hash* |
| 4. Determine accepted or not | *treats an ambiguous submit Horizon reports as failed as non-retryable* |
| 5. Only the documented safe next action | *withholds retry until the envelope can no longer be included* |
| 5. …and not on a stale read | *re-reads the envelope after the expiry ledger rather than trusting a stale absence* |
| 5. …and not on a wrong clock | *judges expiry by ledger close time, not by a host clock running ahead* |
| Unresolvable case | *hands over for reconciliation when Horizon never answers* |

The envelope hash is the identity throughout, which is what makes "resolve the
original transaction" mean the original one rather than a rebuild of it.

## TC-011 — post-broadcast persistence failure cannot cause a second broadcast

| Case step | Assertion |
| --- | --- |
| 2. Persistence fails after acceptance | `payout-service.ts` quarantines to `needs_reconciliation` **while writing `payoutTxHash`** — the hash is persisted even when the success path's write did not complete |
| 3–4. Restart / retry the workflow | `payout-concurrency-db.test.ts` — *refuses to re-broadcast a submission that already carries a hash, even when it reads `failed`* |
| 3–4. Same, at the service boundary | `payout-service.test.ts` — *does not re-broadcast when a txHash is already persisted* |
| 4. Under concurrent recovery | *broadcasts a submission payout once when its retry path is re-entered concurrently* |
| 5. Aggregate correctness | *records total broadcast volume equal to the ledger, with no row paid twice* |

The concurrency assertions run against a real Postgres with the production claim
SQL, advisory locks and unique indexes in force — not against a mocked client.

## What QA can still observe live, without a control

`pnpm qa:fixtures seed` produces **`qa-needs-reconciliation`**: the terminal state
both cases end in — hash present, status terminal, campaign deliberately not
refunded because the funds did leave. QA can confirm on the deployed build that
this state exists, that the co-signer refuses a second signature for it, and that
no retry path will re-broadcast it. That is the observable half of both cases, and
it needs no fault injection.

What cannot be observed without a control is the *transition* into that state.

## The residual, stated plainly

If the process dies between Horizon accepting the payment and the quarantine write
landing, the in-memory envelope identity is lost. Nothing then links the accepted
transaction to the payout reference automatically, and reconciliation is manual
against Horizon.

This is already recorded in section 10 of the readiness guide and in
[#73](https://github.com/webnxt-2030/Centient/issues/73). Accepting this evidence
path does not close it, and the acceptance should not be read as claiming
otherwise.

## If #80 rejects this

Any control that gets built must be test-only, testnet-only, access-controlled,
and absent from the public-network configuration — the same fail-closed shape as
the gated local co-signer, and refusing on an unset value rather than defaulting
to permissive.

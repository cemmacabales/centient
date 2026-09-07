# Hot/Cold Reserve Refill Design

## Goal

Cap a hot-wallet compromise at a configured USDC operating float while keeping
the bulk reserve in a separate Stellar 2-of-3 multisig account. When the hot
float falls to a configured trigger, Centient must identify the exact refill
required to restore the target. Two cold custodians sign that narrowly scoped
transaction independently before a keyless submitter can broadcast it.

## Custody decision

Cold signing stays offline and human-mediated. The application and scheduler
hold only public keys; they never receive a cold secret and can never assemble
two cold signatures by themselves. A custodian signs an already-built XDR on
isolated infrastructure, passes the partially signed XDR to a second custodian,
and the final submit step verifies both signatures and the full transaction
shape before contacting Horizon.

This is preferred over injecting two cold seeds into a worker, which would turn
the reserve into another online hot wallet. A remote-signer service is also out
of scope because issue #8 owns the independent signing-service boundary.

## Policy and configuration

The refill policy uses exact 7-decimal Stellar units (`bigint`) throughout:

- `STELLAR_COLD_RESERVE_ACCOUNT`: cold reserve public key.
- `STELLAR_COLD_OPS_SIGNER_PUBLIC`: operations co-signer.
- `STELLAR_COLD_POLICY_SIGNER_PUBLIC`: policy co-signer.
- `STELLAR_HOT_FLOAT_TRIGGER_UNITS`: refill trigger, inclusive.
- `STELLAR_HOT_FLOAT_TARGET_UNITS`: post-refill target; strictly greater than
  the trigger.
- `STELLAR_COLD_MIN_RETAIN_UNITS`: reserve floor that a refill may never cross.

The hot destination is derived from `STELLAR_PLATFORM_SECRET`, the same source
used by the payout rail and wallet-health code. It is never accepted as a CLI
argument, preventing an operator typo from redirecting a refill.

The allowed signing set is the cold account's master public key plus the two
configured co-signer public keys, matching the on-chain 2-of-3 topology. All
account IDs and signer IDs must be valid, distinct Stellar public keys.
All amount settings must be non-negative decimal integer strings, and the
target must be positive and greater than the trigger. Production has no hidden
defaults: missing policy values fail closed. Tests pass an explicit environment
object rather than mutating global configuration.

## Planning behavior

The planner consumes current hot and cold USDC balances and produces one of
three results:

1. `healthy`: hot balance is above the inclusive trigger; no refill is built.
2. `refill_required`: amount is exactly `target - hot`; applying it restores the
   configured target, and the cold balance remains at or above its retain floor.
3. `insufficient_reserve`: the exact target refill would cross the retain floor;
   no partial refill is built and operators must intervene.

A partial refill is deliberately rejected. It complicates audit reasoning and
can mask a depleted reserve without restoring the documented operating float.

## Transaction construction and validation

`lib/stellar/reserve-refill.ts` is a network-free core plus thin injected I/O:

- parse and validate the policy;
- extract exact USDC units from Horizon balance lines without floating point;
- compute the deterministic plan;
- build one time-bounded transaction sourced by the cold account, containing
  exactly one configured-USDC payment to the configured hot account;
- validate a submitted XDR against source, sequence-bearing transaction type,
  network passphrase, time bounds, fee bounds, asset, destination, amount, and
  allowed signer identities;
- cryptographically verify at least two distinct allowed cold signatures against
  the transaction hash;
- print the signed hash before a single Horizon submission, then require Horizon
  to return that same hash.

The cold account pays its own transaction fee. It must therefore retain enough
XLM for its base reserve, USDC trustline, and infrequent refill fees. The retain
floor applies to USDC; the runbook separately specifies the minimum XLM health
check. Fee bumping is unnecessary for an operator-controlled reserve account.

The validator rejects extra operations, a different asset or issuer, a changed
destination, an amount other than the current deterministic plan, excessive
fees, absent/expired time bounds, unknown signatures, duplicate signer keys,
and fewer than two valid allowed signatures. Stellar sequence numbers and time
bounds make a successfully submitted envelope non-replayable.

## Scheduled detection and operator flow

`POST /api/cron/reserve-refill` follows the repository's existing authenticated
cron route pattern. It loads hot and cold balances and returns the current plan:

- HTTP 200 with `healthy` when no action is needed;
- HTTP 202 with `refill_required` and the exact amount when custodians must act;
- HTTP 503 with `insufficient_reserve` when the reserve cannot restore target;
- HTTP 500 for configuration or Horizon failures.

The cron endpoint never builds a short-lived XDR. Building one on every
unattended scheduler pass would create stale competing envelopes for the same
sequence number. Instead, the operator CLI performs the lifecycle:

1. `status` repeats the read-only plan.
2. `prepare` reloads both accounts, requires `refill_required`, and prints an
   unsigned XDR plus its exact hash and human-readable summary.
3. `sign` accepts an XDR and exactly one custodian seed in the process
   environment, revalidates its unsigned shape, adds that signature, and prints
   the new XDR. Each custodian runs this independently; no invocation sees two
   seeds.
4. `submit` reloads balances, recomputes the plan, requires two valid configured
   signatures and an exact current amount, prints the hash first, and submits
   once. Unknown outcomes are reconciled by hash and never blindly retried.

## Provisioning and evidence

The cold setup script reuses the repository's tested native 2-of-3 threshold
builder with cold-specific environment names. On testnet it may friendbot-fund
a new account, add the configured USDC trustline, and configure master, ops, and
policy keys at weight 1 with low/medium/high thresholds of 2. It prints secrets
only when generating throwaway testnet keys and warns operators to move them to
separate secret stores; no seed is written to the repository.

The committed runbook records:

- cold account and signer public keys, thresholds, and explorer evidence;
- configured trigger, target, retain floor, and worst-case-loss calculation;
- setup, status, prepare, two-party signing, submit, and hash reconciliation;
- XLM and USDC funding/trustline prerequisites;
- rotation, emergency stop, insufficient-reserve, stale-sequence, and unknown
  submission procedures;
- a live testnet refill transaction when faucet funding is available.

Public addresses, thresholds, balances, and transaction hashes are safe to
commit. Seeds and signed-but-unsubmitted XDRs are not committed.

## Testing

Vitest coverage must prove:

- policy parsing rejects missing, malformed, overlapping, or unsafe settings;
- decimal Horizon balances convert to exact units without float math;
- healthy, exact-refill, boundary-trigger, and insufficient-reserve plans;
- the builder emits one time-bounded cold-to-hot USDC payment for the exact plan;
- validator rejection for source, asset, issuer, destination, amount, operation
  count, fee, time-bound, and signature tampering;
- two distinct valid configured signatures pass, including a four-byte signature
  hint collision regression;
- submit logs the hash before I/O and never retries an unknown outcome;
- cron authentication and HTTP status/result mapping.

The issue closes only after focused tests, the full suite, typecheck, production
build, GitHub CI, current-head review, human merge, and live evidence or an
explicitly documented external faucet blocker.

## Out of scope

- Automated custody of two cold seeds in one process.
- Remote signing-service infrastructure (issue #8).
- Daily payout-cap enforcement (issue #9).
- General payout-engine replacement (issue #7).
- Admin UI for reserve operations; the authenticated cron response, CLI, logs,
  and runbook are the issue #10 operator surface.

# Stellar multisig payout service (E1-3 #7)

Every contributor payout settles as a **two-signature, fee-bumped USDC payment**
from the multisig payout account. The single-key `stellar/client.payUsdc`
broadcast is no longer on the reward path. This document is the operational
reference for that rail: how a payout is assembled, what serializes it, how it
fails, and what to configure.

## The settlement path

```
payReward
  └─ checkPayoutCap                     cap gate, before anything is built
  └─ resolvePayoutCoSigner              fail closed if no second signer exists
  └─ submitMultisigPayout               ── one mutex from here to submit ──
       ├─ loadAccount(payout account)   the sequence number
       ├─ buildPayoutPayment            exact stroops, G… destination
       ├─ signAsPlatform                signature #1 (ours)
       ├─ coSigner.signPayout("payment")     signature #2 (independent, #8)
       ├─ assertPayoutFullySigned       both keys verified against the hash
       ├─ buildMultisigFeeBump          Centient pays the XLM fee
       ├─ signAsPlatform                signature #1 on the fee bump
       ├─ coSigner.signPayout("fee_bump")    signature #2 on the fee bump
       ├─ assertPayoutFullySigned       both keys verified again
       └─ submitTransaction
```

Both envelopes are signed, because both are sourced by the payout account and
its thresholds are 2/2/2. That is two co-signer round trips per payout, by
design — the fee bump wraps the already-dual-signed payment, so it cannot be
built before the inner signatures exist.

## What guarantees two signatures

`assertPayoutFullySigned` never counts signatures. A decorated signature's hint
is only four bytes, so two distinct signers can legitimately collide, and one key
signing twice would otherwise read as two parties. Each required key is verified
cryptographically against the envelope hash instead. Both cases are covered by
unit tests, and issue #12 proves the invariant across the whole lane.

The co-signer returns a **detached signature**, never a transaction. We merge it
into our own envelope and verify it against our own hash, so a compromised or
buggy co-signer cannot substitute a different payout — the worst it can do is
refuse to sign. A signature produced over any other envelope simply does not
verify.

## Sequence safety

The payout account has exactly one sequence number. The entire build → sign →
co-sign → submit cycle runs inside one mutex in `payout-submitter.ts`, which is
the single owner of that critical section. `payReward` deliberately takes no lock
of its own; a second mutex would risk a deadlock and serialize the cap check for
no safety gain.

The lock is held across both co-signer round trips. That is deliberate: a slow
co-signer serializes payouts, which is correct, where a released lock would hand
two concurrent payouts the same sequence number. **A slow or unreachable
co-signer therefore shows up as payout throughput collapsing, not as incorrect
payouts.** If payouts are backing up, check the co-signer's latency first.

The regression test issues twelve simultaneous payouts and requires twelve
distinct sequence numbers. With the mutex removed it fails with one distinct
sequence across all twelve.

### The lock is process-local — run exactly one submitter

`payoutSeqMutex` is an in-process mutex. It serializes concurrent payouts inside
one Node process and nothing beyond it. Anything that submits from
`STELLAR_PLATFORM_ACCOUNT` in a *second* process — a horizontally scaled web
instance, a standalone `npm run payout` worker alongside the in-process one, or
`/api/cron/payout-retry` calling `reprocessPayoutWithNonceSafety` concurrently
with the worker — can draw the same sequence number.

That collision is not silent: the loser gets `tx_bad_seq`, rebuilds once, and on a
second collision fails retryably so the job requeues. It costs throughput and
retries rather than correctness. But it means **the deployment must run exactly
one payout submitter**, and scaling the payout path horizontally requires a
distributed lock spanning the whole load → build → co-sign → submit cycle, not
just the submit.

This constraint is inherited, not introduced: `payUsdc`'s `seqMutex` was equally
process-local. It is recorded here because the multisig service holds its lock for
longer — across two co-signer round trips — which widens the window in which a
second process can interleave.

## Failure modes

| Condition | Retryable? | Behavior |
|---|---|---|
| `op_no_trust` — recipient holds no USDC trustline | **No** | Permanent failure, surfaced unchanged to the worker, which marks the payout failed and refunds. See the failure runbook. |
| `op_no_destination` — recipient unfunded | **No** | Same as above. |
| `tx_bad_seq` — stale sequence | **Yes** | Rebuilt and resubmitted **once**. The rebuild re-enters the whole cycle, including both co-signatures, because a rebuilt envelope has a new hash. Sustained contention is classified retryable so the worker requeues with its own backoff instead of spinning inside the lock. |
| Ambiguous submit (timeout, dropped socket, post-acceptance 5xx) | **Only once provably dead** | No rebuild. The envelope hash is known before submission, so Horizon is polled for that exact transaction until it resolves, or until the envelope's time bounds expire. A payout that settled returns its real hash. Expiry yields `ambiguous_submit` marked retryable, because the envelope can no longer be included. |
| Ambiguous submit on an envelope with no time bounds | **No** | Cannot be proven dead, so it is reported non-retryable for manual reconciliation rather than risking a second settlement. |
| Co-signer refuses | **No** | Nothing is submitted. The payout fails with the co-signer's reason. |
| Co-signer answers with the wrong key | **No** | Rejected before submission. Indicates a configuration or transport fault — check `STELLAR_POLICY_SIGNER_PUBLIC`. |
| Co-signer signature does not verify | **No** | Rejected before submission. Indicates envelope tampering or a signer/network-passphrase mismatch. |
| No co-signer configured | **No** | `payReward` throws before building anything. There is no single-signature fallback. |

Nothing in this table can produce a submitted single-signature payout, and nothing
in it rebuilds a payout whose first envelope might still settle.

### Residual: process death mid-submit

The envelope hash that makes ambiguity recoverable lives in memory for the duration
of the call. If the process dies between `submitTransaction` and the resolution
loop, that identity is lost and the job requeues without it — the one remaining
path to a double settlement. Closing it requires persisting the hash before
submitting and reconciling it before any reissue, which is a payout state-machine
change rather than a submitter change.

## Configuration

| Variable | Meaning |
|---|---|
| `STELLAR_PLATFORM_ACCOUNT` | The multisig payout account (`G…`) that sources both envelopes and pays the XLM fee. |
| `STELLAR_OPS_SIGNER_SECRET` | Our own signing key — signature #1, held in this process. |
| `STELLAR_POLICY_SIGNER_PUBLIC` | The independent co-signer's public key. Must differ from the ops key; a configuration pointing both at one key is rejected, because two signatures from one party is not a 2-of-3. |

### The local co-signer is a development affordance

Until #8 ships the policy service, `resolvePayoutCoSigner` can return an
in-process signer that holds the policy secret directly. **One process holding
both keys is single-party control wearing a multisig's clothes.** It exists so
#7 can demonstrate two-signature settlement on testnet, and it is gated
accordingly:

- refused outright when `STELLAR_NETWORK=public`;
- requires `STELLAR_ALLOW_LOCAL_COSIGNER` to be exactly `"true"`;
- requires `STELLAR_POLICY_SIGNER_SECRET`, and rejects a secret that disagrees
  with `STELLAR_POLICY_SIGNER_PUBLIC`.

It is not a deployment option. Mainnet requires the #8 service.

Even so, it is not a rubber stamp: it re-derives the payment from the envelope —
unwrapping a fee bump to reach the inner operation — and refuses unless the
destination, the exact stroop amount, and the single-payment shape all match the
request. #8's service performs the same comparison against its own copy of the
task ledger.

## Payout references

A payout carries a discriminated reference rather than a bare id:

- `{ kind: "submission", id }` — a per-submission reward.
- `{ kind: "payout_job", id }` — a lump-sum payout job.

The two paths draw from different tables, and the co-signer re-derives the amount
from whichever row the reference names. A single opaque id would leave it
guessing which table to read.

## Amount handling

Amounts travel as integer `bigint` units end to end and are never parsed through
`Number`. Stellar's ceiling — 922,337,203,685.4775807 of a 7-decimal asset — is
four orders of magnitude past `Number.MAX_SAFE_INTEGER`, so a single float
round-trip anywhere on this path would move money silently. `payout-amount.ts`
owns the assertions and pins an exact round-trip at dust, ordinary, and ceiling
values.

Zero-value payouts are rejected before an envelope is built: they are no-ops that
still burn a sequence number and a fee.

## Live testnet evidence (2026-09-08, #73)

`pnpm stellar:payout:proof <G destination> <amount units> <reference id>` drives
the real `payReward` path end to end — cap check, platform signature, gated
local co-signature, fee-bump, sequence-safe submit — and prints the hash. It is
testnet only: it refuses any other network, and the local co-signer it relies
on is refused on the public network regardless.

Two payouts from the 2-of-3 payout account
`GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6`, both verified on
Horizon as fee-bump envelopes carrying two signatures on the inner payment and
two on the outer envelope, fee 200 stroops paid by the payout account:

| Purpose | Destination | Amount | Fee-bump hash |
|---|---|---|---|
| Contributor payout (the #7 DoD item) | `GA4XSHGIOVGWI6ZGDIRFG3ROFOHXRDVHH5YKGFKC5C2LHOT6EB5WCQXI` (the #6 sponsored recipient, holds 0 XLM) | 0.1 USDC | [`9f6b8ae9…996c`](https://stellar.expert/explorer/testnet/tx/9f6b8ae96a2d17cf3ba2fd585f1e434287bc7113d33f5ecec75cbbe53470996c) |
| Treasury transfer to fund the cold reserve | `GDPGRS4P6UZZK23CKKELGLJAYTCAWPV4C7TH6Q322SF735A5H6U5XK5G` | 10 USDC | [`452fd680…d836`](https://stellar.expert/explorer/testnet/tx/452fd68061ecae052ebd681ee47010adbc2e05c01c86afb9bba685a77fb1d836) |

The recipient's balance went from 1.0 to 1.1 USDC with 0 XLM spent. Both ran
with `DAILY_PAYOUT_CAP_UNITS=0` so the proof did not depend on a database.

## What #7 does not do

- It does not implement the independent co-signer's transport, isolation, or
  ledger re-derivation. That is **#8**, behind the `PayoutCoSigner` interface.
- It did not originally enforce a daily cap at the co-signer. **#9** now supplies
  that second, independent gate; see the
  [daily payout cap runbook](stellar-daily-payout-cap-runbook.md).
- It did not remove every remaining single-key broadcast path elsewhere in the
  codebase, nor add the lane-wide signature-count regression guard. **#12 closed
  that**: `lib/stellar/__tests__/no-single-key-payout.test.ts` scans `lib/`,
  `app/`, `services/` and `scripts/` and fails if any module outside a justified
  allowlist reaches Horizon's submit, builds a USDC payment, or reads the
  platform signing secret — paired with boundary cases proving this submitter
  refuses anything short of two distinct verified signatures on both envelopes.
  See [the payments-lane evidence](payments-lane-evidence.md), which also names
  the residual risks the guard does not cover.

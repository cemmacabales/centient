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

## Failure modes

| Condition | Retryable? | Behavior |
|---|---|---|
| `op_no_trust` — recipient holds no USDC trustline | **No** | Permanent failure, surfaced unchanged to the worker, which marks the payout failed and refunds. See the failure runbook. |
| `op_no_destination` — recipient unfunded | **No** | Same as above. |
| `tx_bad_seq` — stale sequence | **Yes** | Rebuilt and resubmitted **once**. The rebuild re-enters the whole cycle, including both co-signatures, because a rebuilt envelope has a new hash. Sustained contention is classified retryable so the worker requeues with its own backoff instead of spinning inside the lock. |
| Co-signer refuses | **No** | Nothing is submitted. The payout fails with the co-signer's reason. |
| Co-signer answers with the wrong key | **No** | Rejected before submission. Indicates a configuration or transport fault — check `STELLAR_POLICY_SIGNER_PUBLIC`. |
| Co-signer signature does not verify | **No** | Rejected before submission. Indicates envelope tampering or a signer/network-passphrase mismatch. |
| No co-signer configured | **No** | `payReward` throws before building anything. There is no single-signature fallback. |

Nothing in this table can produce a submitted single-signature payout.

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

## What #7 does not do

- It does not implement the independent co-signer's transport, isolation, or
  ledger re-derivation. That is **#8**, behind the `PayoutCoSigner` interface.
- It does not enforce a daily cap at the co-signer. The existing cap runs at
  `payReward`; the second, independent cap is **#9**.
- It does not remove every remaining single-key broadcast path elsewhere in the
  codebase, nor add the lane-wide signature-count regression guard. That is **#12**.

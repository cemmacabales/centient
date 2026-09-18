# Week 3 — 21–27 Sep

**Window:** 21–27 September 2026 · **Focus:** D3, the end-to-end contributor loop

**Deliverable:** [D3 — End-to-end contributor loop](../deliverables/d3.md)

{% hint style="info" %}
**Not started.** This page holds the plan and is replaced by the week's report as work lands. Week 3 starts when Epic 2 closes, meaning QA gate #31 has recorded `QA PASSED <sha>`.
{% endhint %}

## What this week changes

Weeks 1 and 2 built the two halves: a payout rail no single key can drain, and a wallet that is its owner's identity. Week 3 joins them. A contributor connects, ranks a pair, passes the quality guards, and **the validation itself** pays them, with no balance in between:

```
connect → rank → validate → co-sign → pay → reconcile
```

Today, a validated submission still credits an off-chain balance that the contributor withdraws later. At the end of this week, that step is gone from the active contributor path.

## Plan

Development runs Monday–Wednesday, one issue at a time, each through CI → review → human merge. The cut is Wednesday 23 September at end of day.

| Day | Issue | Done when |
| --- | --- | --- |
| Mon 21 | #35 · Ranking UI on wallet-native sessions, mobile-first and keyboard-accessible | A wallet-authenticated contributor completes a ranking on mobile and by keyboard. Focus, selection, error and progress states are covered |
| Mon 21 | #36 · Quality guards keyed to the Stellar address: gold tasks, rate limits, spam | Every guard uses wallet identity. A rejected submission creates no payout intent |
| Tue 22 | #37 · Validated submission → instant multisig payout | A durable validated submission reaches the multisig rail and shows a truthful pending / sent / confirmed status. Rejected or unverifiable state never reaches signing |
| Tue 22 | #38 · Idempotency-safe retries | Concurrent and repeated attempts produce one ledger payment and at most one transfer. An unknown Horizon outcome stays reconcilable and is never blindly resubmitted |
| Wed 23 | #39 · Retire accumulate-then-withdraw | The active path has no balance or withdrawal step. Existing balances have a documented, tested treatment |
| Wed 23 | #40 · Reconciler on the instant-payout ledger | Every evidence-run payout has explicit pending / confirmed / failed status. A zero-unreconciled report can be reproduced |
| Thu–Fri 24–25 | #41 · QA gate: manual QA, end-to-end tests, evidence package | `QA PASSED <sha>` |
| Sat 26 | SDF review | — |

#37 depends across epics on Epic 1's #7, #8 and #9. It builds on the payout service, co-signer and cap exactly as QA passed them.

## Evidence this week must produce

* A run from a **fresh wallet**: connect → rank → validated → USDC arrives in that wallet, with the transaction on stellar.expert
* A **rejected** submission that is visibly rejected and moves no funds
* A **retry** of the same submission that produces no second on-chain payment
* A reconciler report with **zero** unreconciled payouts across the run
* End-to-end CI lane green

## What Centient must address this week

These carry in from Weeks 1–2, or are new risks Week 3 creates. Each has an owner decision or a named issue. → [Open risks](../reference/risks.md)

* **Hold the development stop.** Week 2's cut was followed by seven post-cut merges. Week 3's QA window is the same two days and cannot absorb that. After Wednesday end of day, nothing merges until #41 records its verdict.
* **Decide mobile before #35 (D-4).** "Mobile-first" in #35 means a phone browser. Freighter on a phone needs WalletConnect v2, which nothing in the plan builds. Decide with cohort data whether it enters scope, because the Week 4 target of 25 unique wallets may depend on it.
* **Existing custodial balances (#39).** On 15 September, staging held 10 email-only accounts, 5 of them with a balance. Retiring withdrawal must not strand that value. The treatment has to be decided and tested, not assumed.
* **The cap under instant volume.** When every validation is a payout, the daily cap and hot-float refill run at real task volume for the first time. Check the deployed cap and the 20 / 24 / 5 refill policy against the Week 4 volume run (≥100 payouts) before it starts.
* **Session revocation.** Logout does not revoke the 7-day JWT. Once a session can trigger payouts directly, decide whether that is still acceptable.

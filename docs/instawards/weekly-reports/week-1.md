# Week 1 — 7–13 Sep

**Window:** 7–13 September 2026 · **Focus:** D1, the instant USDC reward rail

**Deliverable:** [D1 — Instant USDC reward rail](../deliverables/d1.md) · **Evidence:** [accounts](../reference/evidence.md#accounts) · [transactions](../reference/evidence.md#deliverable-1-transactions)

*Final report for the week. QA's verdict was recorded on Monday 14 September, the first day of Week 2, and the verdict is included here.*

## Summary

Centient no longer has a single key that can pay a contributor. Every payout now leaves a **2-of-3 multisig** account, and the network itself refuses a payment carrying fewer than two signatures. The second signature comes from an **independent policy co-signer**, which re-derives the amount and destination from the task ledger rather than trusting the request it receives. A **daily cap** is enforced separately at both signers, so neither one can lift it alone. Bulk funds sit in a separate 2-of-3 **cold reserve** that only refills the hot wallet through multisig-approved transfers. Centient pays every fee through fee-bump, so the contributor receives the full USDC amount.

The first real payout signed by two independent keys settled on 7 September ([`91b46b51…`](https://stellar.expert/explorer/testnet/tx/91b46b51e73c5ec650913dd395c803e16a7ca32d44d962e4e61be8134df20b3c), fee-bumped by [`be8a6a23…`](https://stellar.expert/explorer/testnet/tx/be8a6a2363401ff77f3634b8af47db88a4e2706e401319fa8ecd2412342e9154)). A payments-lane CI job now fails the build if any code path could broadcast a payout with fewer than two verified signatures. The check was proven by deliberately injecting such a path.

The QA pass found a real hole. **The code was right, but the deployment was not:** the `web` service held two payout-signer seeds, which together met the threshold, so it could pay without the co-signer (finding F-01, TC-028). Every code-level check stayed green. The fix (PR #93) makes the payout boundary refuse a deployment that holds enough signer weight to reach the threshold alone, and the extra seed was removed from `web`. QA re-ran the full suite and passed **28 of 28** at [`263be4c`](https://github.com/cemmacabales/centient/commit/263be4cd5ab06103d965044c6a8bd3c40678f308). Deliverable 1 was promoted to `main` on 14 September.

## Plan against actual

Development was planned for Monday–Wednesday. It finished **a day early**, on Tuesday 8 September at [`7437678`](https://github.com/cemmacabales/centient/commit/743767823156a5dbe434b376a0a8beb9c2726634).

| Day | Planned | Actual |
| --- | --- | --- |
| Mon 7 Sep | #5 multisig account, #6 spike, #10 hot/cold reserve | All three merged. #7, the payout service, also merged, a day ahead of its slot. 20 atomic commits against a target of 10 |
| Tue 8 Sep | #7 payout service, #8 co-signer, #11 wallet health | #11 and follow-up #73 merged, then #8, #9 and #12. **The dev cut was reached**. 39 commits |
| Wed 9 Sep | #9 daily cap, #12 payments-lane proof | QA fixtures (#88), readiness guide, promotion to `staging` (PR #84) |
| Thu–Fri 10–11 Sep | QA pass (#80) | F-01 found on the 11th, fixed and re-tested the same day |
| Sat 12 Sep | SDF review | — |
| Mon 14 Sep | — | `QA:PASSED` recorded on #80 at `263be4c`; #4 closed; promoted to `main` (PR #92) |

**One slip, flagged the same day:** #8 did not start on its Tuesday slot. It waited on the co-signer hosting decision (see [Decisions](#decisions)) and landed on Tuesday evening after that decision was made.

## Changelog

Pull requests merged into `develop` or promoted this week, oldest first. Commit links open the merge commit on the public mirror.

| Date | Change | Issue | PR | Commit |
| --- | --- | --- | --- | --- |
| 09-07 | Remove the agent-ready automation; development is manual from here on | — | #61 | [`5307875`](https://github.com/cemmacabales/centient/commit/5307875c71b04bc5b38aa60fbb6dfb31b7c2518a) |
| 09-07 | Re-provision the testnet multisig proof on an operable account | #5 | #62 | [`c8eded2`](https://github.com/cemmacabales/centient/commit/c8eded2179a52aeeb5e1e2b589bf94c94aed491f) |
| 09-07 | Prove a multisig USDC fee-bump payout end to end | #6 | #64 | [`dca64c6`](https://github.com/cemmacabales/centient/commit/dca64c6a0cb9ca2257197f160225305d47bf4560) |
| 09-07 | Multisig cold-reserve refills | #10 | #65 | [`7b9d2eb`](https://github.com/cemmacabales/centient/commit/7b9d2ebacc291f8dbb79ad273fa5d4f7b85ecb17) |
| 09-07 | Multisig payout service with sequence-safe submission | #7 | #66 | [`8ad80c3`](https://github.com/cemmacabales/centient/commit/8ad80c328685be0abc4d2b6b930c8e582b08eb2c) |
| 09-07 | Close the ambiguous-submit window | #7 | #69 | [`3bc6920`](https://github.com/cemmacabales/centient/commit/3bc6920e44879ce47f243c5f768024d8b1c40ef5) |
| 09-07 | Resolve an ambiguous submit only on proof, and never refund one | #7 | #70 | [`5f4b58c`](https://github.com/cemmacabales/centient/commit/5f4b58c4d0ca9491b7b4d2f3248f09378cc6ddfe) |
| 09-08 | Dual-asset (USDC + XLM) wallet-health monitoring | #11 | #72 | [`6fee0a9`](https://github.com/cemmacabales/centient/commit/6fee0a972f844c7f403698f4b8f4cf2f830aae1d) |
| 09-08 | Close the submission double-pay window and spec-review gaps | #73 | #74 | [`b96c89d`](https://github.com/cemmacabales/centient/commit/b96c89d5ae07ae919709d85236b1b972588d134e) |
| 09-08 | Independent policy co-signer that re-derives payouts from the task ledger | #8 | #75 | [`2bdd6a0`](https://github.com/cemmacabales/centient/commit/2bdd6a0c4b77b933b6fdcfa97ab29f7dd7da2939) |
| 09-08 | ADR-0001: simulated co-signer isolation | #8 | #71 | [`7efc104`](https://github.com/cemmacabales/centient/commit/7efc104bda28bd7bdfac4974a78bf6ff67a5e380) |
| 09-08 | Co-signer adapted to the same-project topology, with a setup wizard | #8 | #76 | [`85b0fb2`](https://github.com/cemmacabales/centient/commit/85b0fb2c24971cbe70d05a72ffd897a0d0a48824) |
| 09-08 | Enforce independent daily payout caps at both signers | #9 | #78 | [`3862ac3`](https://github.com/cemmacabales/centient/commit/3862ac37bb8dbfeebdc6fa2460bb8546b0ff83b4) |
| 09-08 | Payments-lane proof: no single-key path, zero double-pays, named CI lane | #12 | #79 | [`7437678`](https://github.com/cemmacabales/centient/commit/743767823156a5dbe434b376a0a8beb9c2726634) |
| 09-08 | CI: exempt merge commits from the commit-identity rule | — | #83 | [`3fd157f`](https://github.com/cemmacabales/centient/commit/3fd157fd995e70e7d2468465b16b7c6e46aff69d) |
| 09-09 | QA fixtures, reset path, CI at the deployed SHA | #86 | #88 | [`0187170`](https://github.com/cemmacabales/centient/commit/0187170a02376062185e872d11775d5da5961f4c) |
| 09-09 | Refresh the Deliverable 1 QA readiness guide | #13 | #89 | [`650c624`](https://github.com/cemmacabales/centient/commit/650c62435b193e0a6ad3f6e72a9f34dd6fc40bb0) |
| 09-09 | **Promote `develop` → `staging`**: Deliverable 1 payout rail | — | #84 | [`6ea51e0`](https://github.com/cemmacabales/centient/commit/6ea51e0ef6f3dd467b7eebf34bf80fdf67fff921) |
| 09-11 | **Enforce deployment-level signer custody** (F-01 fix) | #80 | #93 | [`8067123`](https://github.com/cemmacabales/centient/commit/80671230d95891d1bb5a22536298bf3303c2d5e4) |
| 09-11 | Promote to `staging`: F-01 custody fix. **This is the SHA QA passed** | — | #94 | [`263be4c`](https://github.com/cemmacabales/centient/commit/263be4cd5ab06103d965044c6a8bd3c40678f308) |
| 09-11 | Restate the deployed reserve policy as 20/24/5 after the TC-021 refill | — | #95 | [`a1137f9`](https://github.com/cemmacabales/centient/commit/a1137f977713b02b907e16f267da76bebfbf3349) |
| 09-14 | **Promote `staging` → `main`**: Deliverable 1 | — | #92 | — |

## Decisions

**The co-signer runs in its own Railway project, not a separate account (8 Sep).** The plan asked for a separate company-owned Railway account for the co-signer. That approval would have blocked Week 1 on billing and ownership paperwork for a rail with nothing of value on it, so it was withdrawn for the MVP. The co-signer has its own container, service-scoped variables, deploy trigger and member list. It uses HMAC-authenticated transport and a read-only database role for re-deriving from the ledger, and the app refuses to boot if it can see both the co-signer URL and the policy secret. **What this does not buy:** one Railway account, one repository, one CI and one database instance. The limit is machine-checked: `COSIGNER_ISOLATION_LEVEL=same-workspace` refuses to sign when `STELLAR_NETWORK=public`. → [ADR-0001](https://github.com/cemmacabales/centient/blob/develop/docs/adr/0001-simulated-cosigner-isolation.md)

**Seeded QA credentials accepted on testnet (9 Sep).** The shared QA logins were left as they were for the internal testnet pass. They are recorded as an accepted risk with explicit exit criteria. → [ADR-0002](https://github.com/cemmacabales/centient/blob/develop/docs/adr/0002-seeded-credentials-accepted-on-testnet-qa.md)

**A cap-alert ordering defect is fixed inside #12, not deferred (8 Sep).** The success-path cap alert used to fire before the payout was persisted, so it could read a stale total and miss a threshold crossing. It now runs at the three sites that persist the payout, each right after that write succeeds. An ordering-controlled test covers it. → [payments-lane evidence](https://github.com/cemmacabales/centient/blob/develop/docs/payments-lane-evidence.md)

## What QA found

| Finding | What it was | Resolution |
| --- | --- | --- |
| **F-01** (TC-028) | `web` held the payout master and the ops signer, weight 1 each against a threshold of 2. It could pay alone, bypassing the co-signer. Proof tx [`81d799d3…`](https://stellar.expert/explorer/testnet/tx/81d799d3315421707d64ad3ca0d7903598b0839d8a1af5638347bd13615717fd) | PR #93: `assertCustodyBelowThreshold` refuses the configuration at the payout boundary. A dedicated sponsor key keeps sponsorship from reusing a payout signer. The master seed was removed from `web`. Re-verified: `web` holds weight 1 of 2 |
| Reserve policy drift (F-02) | Documents quoted older refill thresholds than the deployed values | The deployed policy is restated as 20 / 24 / 5 USDC, and testers now read the live values instead of copying them from documents |

**What F-01 teaches:** "no single *code path*" and "no single *deployment*" are different properties. The first is tested. The second now is too, and it must be re-checked whenever a new Stellar seed is added to any service.

## Evidence added

* Payout account and cold reserve, both 2-of-3 with thresholds 2/2/2, verifiable on stellar.expert → [accounts](../reference/evidence.md#accounts)
* 11 on-chain transactions, re-verified live on 11 September, 7 of them carrying two or more signatures → [D1 transactions](../reference/evidence.md#deliverable-1-transactions)
* Payments-lane CI job: at 11 September, 55 files and 713 tests; the full suite 81 files and 1,031 tests, all passing
* Runbooks: [multisig](https://github.com/cemmacabales/centient/blob/develop/docs/stellar-multisig-runbook.md), [daily cap](https://github.com/cemmacabales/centient/blob/develop/docs/stellar-daily-payout-cap-runbook.md), [cold reserve](https://github.com/cemmacabales/centient/blob/develop/docs/stellar-cold-reserve-runbook.md), [payout failure](https://github.com/cemmacabales/centient/blob/develop/docs/stellar-payout-failure-runbook.md)

## By the numbers

| Measure | Week 1 |
| --- | --- |
| Pull requests merged | 22 |
| Issues closed | 16 |
| QA cases passed | 28 / 28 |
| On-chain transactions verified | 11 / 11 |

## Carried into Week 2

* `docs/qa/deliverable-1-qa-readiness.md` still names freeze `6bc1180`, which predates F-01. It must be restated before Epic 2 QA reuses it.
* The separate Railway account for the co-signer is now a **mainnet-readiness** item. → [Open risks](../reference/risks.md)

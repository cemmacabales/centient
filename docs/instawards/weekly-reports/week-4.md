# Week 4 — 28 Sep – 4 Oct

**Window:** 28 September – 4 October 2026 · **Focus:** D4, reconciliation, hardening and public release

**Deliverable:** [D4 — Reconciliation and public release](../deliverables/d4.md)

{% hint style="success" %}
**Verdict, 3 October:** QA gate #53 recorded [`QA PASSED`](https://github.com/webnxt-2030/Centient/issues/53#issuecomment-5964089790) at [`e9c28ad`](https://github.com/artisam-centient/centient/commit/e9c28ad9537e2e72d0dd33d374c7338a9094aaec). #45–#49 and #52 are merged and closed, and #50–#51 are out of scope (D-7). The volume proof reconciles 122 payouts across 25 wallets with zero unreconciled, and the full-history report finds zero duplicates. → [D4](../deliverables/d4.md)

The sections below are the plan, written before the week started.
{% endhint %}

## What this week changes

Week 4 tries to break the rail, then proves it in public. It re-verifies both multisig accounts on-chain, injects the four defined failures, and runs a volume proof of **at least 100 reconciled payouts across at least 25 wallets**. It publishes the testnet build with its runbooks and API docs, and records a 3–5 minute demo for a non-technical viewer. Everything runs on **Stellar testnet only** (D-7): there is no mainnet payout.

## Plan

| Day | Issue | Done when |
| --- | --- | --- |
| Mon 28 | #45 · Re-verify hot/cold multisig thresholds | Both accounts have current on-chain evidence matching the design. Any drift blocks the release and moves no funds |
| Mon 28 | #46 · Failure injection: sequence collision, co-signer outage, cap exceeded, Horizon timeout | Every failure has reproducible commands and evidence, and preserves funds, idempotency and truthful state |
| Mon 28 | #47 · Harden errors and dual-asset alerts from the results | Every blocking defect has evidence that it is fixed. Alerts are actionable and deduplicated |
| Tue 29 | #48 · Publish the testnet build, runbooks and payout API docs | The public URL is live and shows its exact deployed SHA. Docs contain no sensitive data |
| Tue 29 | #49 · Volume proof | ≥100 successful settlements across ≥25 unique wallets, with every attempt accounted for, zero duplicates and zero unreconciled |
| Wed 30 | #52 · Demo video and final evidence package | A non-technical reviewer can follow the demo. One index maps every requirement and metric to an artifact |
| Thu–Fri 1–2 Oct | #53 · QA gate and release gate | `QA PASSED <sha>`, zero unreconciled payouts, all CI lanes green |
| Sat 3 Oct | Final SDF review | — |

## What Centient must address before this week

* **Recruit 25 real wallets.** Payouts to 25 distinct addresses need 25 contributors, or a documented and honest test-wallet method. Start recruiting and onboarding testers in Week 3. As of 18 September, the payout account has paid **9** distinct addresses. If mobile is out of scope (D-4), every one of those contributors needs a desktop browser with the Freighter extension.
* **Testnet USDC availability.** If the testnet USDC issuer is unstable during the volume run, SOW §3.8's fallback applies: a Centient-issued test stablecoin for the testnet runs. The reward asset is already configuration-driven. Decide before #49 whether to trigger this fallback, rather than during the run.
* **Fund the float for 100 payouts.** Size the cold reserve and refill policy for the whole run, so the volume proof is not stalled by the cap or the float.
* **Seeded QA credentials.** ADR-0002's code exit criteria are met in #48. Rotating the live accounts is out of scope, because the SOW does not ask for it (amended 28 Sep).
* **Out-of-scope analytics.** PostHog payout events (#119) send wallet addresses. Decide whether that is covered by the privacy notice before the public release.

## Evidence this week must produce

* Current on-chain snapshots of both multisig accounts
* The failure matrix: command, expected behaviour, observed behaviour and evidence for each of the four failures
* The volume-run reconciler report: ≥100 payouts, ≥25 wallets, 0 duplicates, 0 unreconciled
* Public URL with the deployed SHA, runbooks and payout API docs
* The 3–5 minute demo video

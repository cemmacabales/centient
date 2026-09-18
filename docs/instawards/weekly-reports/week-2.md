# Week 2 — 14–20 Sep

**Window:** 14–20 September 2026 · **Focus:** D2, wallet-native contributor onboarding

**Deliverable:** [D2 — Wallet-native onboarding](../deliverables/d2.md) · **Evidence:** [D2 transactions and evidence files](../reference/evidence.md#deliverable-2-evidence)

{% hint style="info" %}
Written on Friday 18 September, the second day of the QA window. All implementation is merged, and QA gate #31 is running against [`8f660cc`](https://github.com/cemmacabales/centient/commit/8f660cc632f1c868a41618434a1c169dc0edabcc). This page is updated when QA records its verdict.
{% endhint %}

## Summary

A contributor no longer needs an email address, a password or any cryptocurrency to start. They connect **Freighter** and sign a one-time challenge that proves they control the address. The server then issues a session keyed to that exact, case-sensitive Stellar address. If the wallet is brand-new and holds no XLM, Centient **sponsors** the account reserve and the USDC trustline, and pays the fee through fee-bump. The contributor signs only the operations that are theirs. The address they signed in with is also the **only** place their USDC can be paid. Email registration now answers `410 Gone`.

Every sponsored reserve is tracked as a platform liability. An operator-run reclaim process takes back the reserves that are safe to take, and it never removes a trustline a payout depends on.

All seven implementation issues merged on **Monday and Tuesday**, and the development cut was reached a day early. The week then broke one of its own rules: **seven application changes merged after the cut**, during what should have been a development stop. None of them belonged to a roadmap issue (see [Plan against actual](#plan-against-actual)). Each one moved the build QA has to test, and the build under test was restated each time until it settled at `8f660cc`. That build has a recorded review (`CLAUDE REVIEW 8f660cc… P0:0 P1:0`).

## Plan against actual

| Day | Planned | Actual |
| --- | --- | --- |
| Mon 14 Sep | #24 wallet spike, #25 signed challenge, #26 wallet-connect session | All three merged, plus #27 and #28 (a day early) and #29 (two days early) |
| Tue 15 Sep | #27 sponsored account, #28 sponsored trustline + fee bump | #30 merged, a day early. **Dev cut reached.** Review fixes (#109) and PostHog client analytics (#108) also merged |
| Wed 16 Sep | #29 reserve reclaim, #30 first-connect | **Development stop not held.** Landing page (#112, #114, #115), Celo cleanup (#111), failure analytics (#110) and instant logout (#117) merged and were promoted |
| Thu–Fri 17–18 Sep | QA pass (#31) | QA window open. #119 (PostHog payout events) merged Thursday, and the build under test was restated to `8f660cc` |
| Sat 19 Sep | SDF review | — |

**Why the post-cut merges matter.** The development stop exists so QA tests one fixed build. Each post-cut merge moved the SHA that QA's pass must name. They were small and outside Deliverable 2's acceptance rows: none changed the schema, added a variable, or touched auth, sponsorship or payout *logic*. Even so, #112 replaced the screen every sign-in test starts from, and #119 runs inside every payout. The rule is restated for Week 3: after the Wednesday cut, nothing merges until the gate records `QA PASSED <sha>`.

## Changelog

| Date | Change | Issue | PR | Commit |
| --- | --- | --- | --- | --- |
| 09-14 | ADR-0002: seeded testnet QA credentials accepted | — | #97 | [`00cb858`](https://github.com/cemmacabales/centient/commit/00cb8583ec5f6476982e2deab5674cc5e24b0005) |
| 09-14 | Freighter-only wallet signing spike: Albedo descoped, testnet proof harness | #24 | #98 | [`34d5094`](https://github.com/cemmacabales/centient/commit/34d5094f4ab15fc851112ec839f7f38797e43046) |
| 09-14 | Signed-challenge sign-in with expiry and replay protection | #25 | #99 | [`b13d7b0`](https://github.com/cemmacabales/centient/commit/b13d7b0710f02d24787b3b83400e84753754dd8a) |
| 09-14 | Freighter wallet-connect and passwordless contributor sign-in | #26 | #100 | [`5a92716`](https://github.com/cemmacabales/centient/commit/5a92716839a121b277e9702f7f6bbc0d8d4aa762) |
| 09-14 | Sponsored account creation for brand-new zero-XLM addresses | #27 | #101 | [`3e791a0`](https://github.com/cemmacabales/centient/commit/3e791a0ba16ef22821d4a5cec7b1695eb4684b97) |
| 09-14 | Sponsored USDC trustline and fee bump for zero-XLM contributors | #28 | #103 | [`fca1191`](https://github.com/cemmacabales/centient/commit/fca1191549e762df069ad0f22278bf31f4bb69d8) |
| 09-14 | CI: cancel superseded runs, scope the contributor check | — | #102 | [`97dbb3c`](https://github.com/cemmacabales/centient/commit/97dbb3c6915a2a19fef419e23be04d3887c90ba8) |
| 09-14 | Track and safely reclaim eligible sponsored reserves | #29 | #104 | [`b83a358`](https://github.com/cemmacabales/centient/commit/b83a358eee56701f7ec67a495941ec78e9b41ca4) |
| 09-15 | First-connect onboarding: wallet identity is the payout destination | #30 | #107 | [`9de7591`](https://github.com/cemmacabales/centient/commit/9de759185bb8882d48eed04ce4d64f4e85120a2f) |
| 09-15 | Redact addresses from a stored reclaim report's error details | #29 | #106 | [`99e3e47`](https://github.com/cemmacabales/centient/commit/99e3e470ba8b33d9afe7bcebfd15ae8e82ca789c) |
| 09-15 | PostHog through a same-origin `/ingest` proxy, key flows instrumented *(outside D2)* | — | #108 | [`81667c8`](https://github.com/cemmacabales/centient/commit/81667c8f9c394be9e2f0827b649226364a585a42) |
| 09-15 | Review findings: a refused proof no longer consumes the challenge; rate limits; recoverable payout setup | — | #109 | [`5d7a2bc`](https://github.com/cemmacabales/centient/commit/5d7a2bccf56a45e489cb4269cf84bace2156ca0a) |
| 09-15 | Promote to `staging`: Deliverable 2 onboarding | — | #105 | [`7ff7dee`](https://github.com/cemmacabales/centient/commit/7ff7dee28f532e5cb9d63199368d42b67bc73d37) |
| 09-16 | Landing page: split hero with the owl up front *(post-cut)* | — | #112 | [`77ddbad`](https://github.com/cemmacabales/centient/commit/77ddbadb597df7f5d85ff51c72bd27d9187fde72) |
| 09-16 | Remove the last Celo artifacts *(post-cut)* | — | #111 | [`6dfea3b`](https://github.com/cemmacabales/centient/commit/6dfea3b98f7351da28854b2b200b445429abf4cc) |
| 09-16 | Track failed withdrawals and wallet-connect failures *(post-cut)* | — | #110 | [`ec4b4e1`](https://github.com/cemmacabales/centient/commit/ec4b4e13f116d1c5adbcb8dd741b1c8c57581fa9) |
| 09-16 | Name the configured reward token in the wallet note *(post-cut)* | — | #114 | [`de07bdd`](https://github.com/cemmacabales/centient/commit/de07bdde719cee2ee0438517899ee3fa18aed44f) |
| 09-16 | Promote to `staging` | — | #113 | [`e3db582`](https://github.com/cemmacabales/centient/commit/e3db582cf84d1c3a0d88ca7e5cd16161982958ec) |
| 09-16 | The landing owl cycles through its poses *(post-cut)* | — | #115 | [`242de94`](https://github.com/cemmacabales/centient/commit/242de946b19e0fdc102c8a6145026e9bc9be9407) |
| 09-16 | Promote to `staging` | — | #116 | [`7564b5c`](https://github.com/cemmacabales/centient/commit/7564b5c644b6236604ab78e2c6392e3202989fce) |
| 09-16 | Logging out returns to the landing page with no reload *(post-cut)* | — | #117 | [`184cd77`](https://github.com/cemmacabales/centient/commit/184cd77544229ad9b9788700e14d884f7dcbe16f) |
| 09-16 | Promote to `staging` | — | #118 | [`b52eb13`](https://github.com/cemmacabales/centient/commit/b52eb1372b8b5105afe5613f19b074bb2de19618) |
| 09-17 | Every on-chain payout recorded in PostHog *(post-cut)* | — | #119 | [`aac52cc`](https://github.com/cemmacabales/centient/commit/aac52ccf6533b69e70876390c817be06bf8d0f40) |
| 09-17 | **Promote to `staging`: the build under test** | — | #120 | [`8f660cc`](https://github.com/cemmacabales/centient/commit/8f660cc632f1c868a41618434a1c169dc0edabcc) |

## Decisions

| ID | Decision | Date |
| --- | --- | --- |
| ADR-0003 | **Freighter only.** Albedo was wired only as a connect-only fallback that could neither prove ownership nor co-sign. Making it real would have doubled the proof and QA matrix in a fully serial week, and no acceptance item requires a second wallet | 14 Sep |
| D-1 | Reserve reclaim is **operator-run, dry run by default**, and revokes only where the owner can absorb the reserve | 15 Sep |
| D-2 | Challenge throttle: **5/min per address, 20/min per IP**. Sponsor and wallet-link routes allow a burst of 5/min | 15 Sep |
| D-3 | Wallet rotation is **out of D2**, recorded as a known limitation | 15 Sep |
| D-4 | Mobile through Freighter + WalletConnect is **decided with cohort data before #35** | 15 Sep |
| D-5 | The QA approval of record is the **`QA PASSED <full-tested-sha>` comment**, not a label, because a comment names the exact SHA the pass covers | 15 Sep |
| D-6 | PostHog backend capture, a staging subdomain for external testers and email notifications are **not D2 scope** | 15 Sep |

**Behaviour changed after the review (PR #109).** A *refused* proof (wrong address, network or signer, or a bad signature) **no longer consumes** the challenge, so the real signer can still use it. Only an accepted proof consumes a challenge, and replaying one returns `401 challenge_not_found`. QA rows use this behaviour.

## What the testnet showed

* **Most sponsored reserves cannot be revoked, and that is correct.** A sponsor-only `revokeSponsorship` fails `op_low_reserve` when the owner holds no XLM, which is exactly the contributor Deliverable 2 serves. For them, reclaim reports the liability and records it as released only if the owner removes the entries. A revocation therefore never strips a trustline a payout needs.
* **A declined prompt leaves nothing behind.** When Freighter's prompt is rejected it returns `-4 The user rejected this request`, and nothing is signed. On the server, a sponsorship envelope that is never submitted creates no ledger row and nothing on-chain.

## Evidence added

* Freighter spike: connect, SEP-53 challenge, 7/7 signature checks, replay refused (`401`), sponsorship signed from the extension → [`2026-09-14-freighter-wallet-signing-evidence.json`](https://github.com/cemmacabales/centient/blob/develop/docs/superpowers/specs/2026-09-14-freighter-wallet-signing-evidence.json)
* Sponsored account creation for a never-funded address: [`b1ef0d3a…`](https://stellar.expert/explorer/testnet/tx/b1ef0d3aa2d3f74f7b86c3cbff840205718e76164b70e3774b5263a3051a435b)
* Sponsored trustline + fee bump, with six forged-envelope refusals: [`776cdee0…`](https://stellar.expert/explorer/testnet/tx/776cdee005e9e46ec990d877f87a024751700e1d5bac5dc83663919a033e4c54)
* Reserve reclaim: 19/19 checks, two revocations on testnet, a second run that sends nothing
* First-connect: every Definition-of-Done line mapped to a named test

All of it is on the [D2 page](../deliverables/d2.md).

## Still to do this week

* [ ] Run QA gate #31 against `8f660cc632f1c868a41618434a1c169dc0edabcc`, and record `QA PASSED <sha>` or the failures
* [ ] Restate `docs/qa/deliverable-1-qa-readiness.md`, which still names `6bc1180`
* [ ] Screen recording: connect → signed challenge → session issued (the §6.1 evidence item)
* [ ] Resolve the open CodeRabbit threads on #112 (fixed by #114) and #119 (test isolation, a one-line fix)
* [ ] Promote the QA-passed SHA, then hold the SDF review on Saturday

## Carried into Week 3

* **Mobile gap.** Freighter Mobile is reachable only over WalletConnect v2, which no Epic 2 issue builds. D-4 decides it before #35. The 25-wallet target in Week 4 may depend on it.
* **Session revocation.** Logging out does not revoke the 7-day JWT.
* **Fee-bump `tx_bad_seq`.** A read from #28 is still unfiled.

All three are tracked on [Open risks and follow-ups](../reference/risks.md).

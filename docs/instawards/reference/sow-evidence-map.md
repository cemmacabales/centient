# SOW evidence map

Every requirement and success metric in the [Statement of Work](../statement-of-work.md), each mapped to an artifact a reviewer can open without an account or a clone. The [evidence index](evidence.md) lists every account and transaction. This page answers a different question: for each thing the SOW asked for, where is the proof?

**Checked on 28 September 2026** against the live build [`983e18b`](https://github.com/artisam-centient/centient/commit/983e18bcc6011dc412a448e9869d39b9ea9b3049) on **Stellar testnet** (D-7). Transaction links open on stellar.expert, and source links open on the public repository at [github.com/artisam-centient/centient](https://github.com/artisam-centient/centient).

## Start here

| What | Link |
| --- | --- |
| The live app | [beta.centient.work](https://beta.centient.work). The deployed SHA is on the sign-in screen and at [`/api/version`](https://beta.centient.work/api/version) |
| The 3–5 minute demo | **Recording in progress (#52).** Linked here once it is published |
| The source | [github.com/artisam-centient/centient](https://github.com/artisam-centient/centient) |
| The volume proof: 122 reconciled payouts to 25 wallets, 0 duplicate, 0 unreconciled | [D4 volume proof](https://github.com/artisam-centient/centient/blob/develop/docs/superpowers/specs/2026-09-28-d4-volume-proof.md) |
| One payout to inspect: 0.25 USDC, two signatures, fee paid by Centient | [`021ab10d…`](https://stellar.expert/explorer/testnet/tx/021ab10d9b79a4011b1718146d798fb424ce68fa8d406e1f34b8829edb08f5e0). Open *Signatures* to see the two signers, and note that the fee is paid by the payout account, not the contributor |
| CI at the live build | [Run 36382675655](https://github.com/artisam-centient/centient/actions/runs/36382675655): [`build`](https://github.com/artisam-centient/centient/actions/runs/36382675655/job/108801484451) ✓ and [`payments-lane`](https://github.com/artisam-centient/centient/actions/runs/36382675655/job/108801484345) ✓ |
| Where delivery differs from the SOW | [Decisions](decisions.md#where-delivery-differs-from-the-sow) |

## Success metrics (§6.3)

The ten metrics, in the SOW's order. The §3.7 sprint targets are the same numbers.

| Metric | Target | Result | Evidence |
| --- | --- | --- | --- |
| Successful USDC reward settlements on testnet | ≥ 100 | ✅ **122**, each reconciled on Horizon | [D4 volume proof](https://github.com/artisam-centient/centient/blob/develop/docs/superpowers/specs/2026-09-28-d4-volume-proof.md). Every payout is listed with its stellar.expert link |
| No single-key payout path (threshold ≥ 2), verifiable on-chain | Yes | ✅ Both accounts 2 / 2 / 2, three signers of weight 1 | [Payout account](https://stellar.expert/explorer/testnet/account/GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO), [cold reserve](https://stellar.expert/explorer/testnet/account/GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6), [re-verification on 28 Sep](https://github.com/artisam-centient/centient/blob/develop/docs/d4-multisig-reverify.md), [no-single-key test](https://github.com/artisam-centient/centient/blob/develop/lib/stellar/__tests__/no-single-key-payout.test.ts) |
| Contributors receive USDC with no XLM of their own | Yes | ✅ Sponsored account and trustline; every payout fee-bumped | Never-funded address sponsored in [`b1ef0d3a…`](https://stellar.expert/explorer/testnet/tx/b1ef0d3aa2d3f74f7b86c3cbff840205718e76164b70e3774b5263a3051a435b), fee-bumped trustline [`776cdee0…`](https://stellar.expert/explorer/testnet/tx/776cdee005e9e46ec990d877f87a024751700e1d5bac5dc83663919a033e4c54) |
| Unique Stellar wallet addresses onboarded | ≥ 25 | ✅ **25** wallets paid through the instant path | [D4 volume proof](https://github.com/artisam-centient/centient/blob/develop/docs/superpowers/specs/2026-09-28-d4-volume-proof.md), *Volume* section |
| Successful mainnet config-flip smoke payout | ≥ 1 | — Out of scope | The sprint is testnet only (D-7). `same-workspace` co-signer isolation refuses to sign on mainnet. → [Decisions](decisions.md#where-delivery-differs-from-the-sow) |
| Automated test suites green in CI (payments, identity, end-to-end) | Yes | ✅ Green at the live build | [Run 36382675655](https://github.com/artisam-centient/centient/actions/runs/36382675655). See [CI lanes](#ci-lanes) for which tests make up each lane |
| Unreconciled payouts | 0 | ✅ **0**, and 0 duplicate | [D4 volume proof](https://github.com/artisam-centient/centient/blob/develop/docs/superpowers/specs/2026-09-28-d4-volume-proof.md). Across all history: 140 reconciled, 0 unreconciled |
| Public testnet URL live & accessible | Yes | ✅ | [beta.centient.work](https://beta.centient.work) |
| Demo video published | Yes | ⏳ Recording in progress | #52. Linked in [Start here](#start-here) once published |
| Public GitHub repository released | Yes | ✅ | [github.com/artisam-centient/centient](https://github.com/artisam-centient/centient) |

## Evidence per deliverable (§4.1, §6.1)

What §6.1 asks each deliverable to submit. Each deliverable page has the full traceability table from issue to commit to evidence.

| Deliverable | §6.1 asks for | Where | Status |
| --- | --- | --- | --- |
| [D1 — Instant USDC reward rail](../deliverables/d1.md) | Payment service in the repo | [Multisig payout service](https://github.com/artisam-centient/centient/blob/develop/docs/stellar-multisig-payout-service.md), [`lib/stellar/`](https://github.com/artisam-centient/centient/tree/develop/lib/stellar) | ✅ |
| | A USDC payout on stellar.expert signed by two keys, fee paid in XLM by Centient | [`5083dd72…`](https://stellar.expert/explorer/testnet/tx/5083dd72a16bfa749c6b302c293e931939acd70cc52f63586443921d60698206), from the deployed payout account | ✅ |
| | The payout account's signers and thresholds (≥ 2), verifiable on-chain | [`GCP34RIT…4BUO`](https://stellar.expert/explorer/testnet/account/GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO), set in [`e966c0a5…`](https://stellar.expert/explorer/testnet/tx/e966c0a5c27cbe0253f2812d158b38f8e91513de48254923f9ecb6f4c19630fd) | ✅ |
| | Payments-lane tests passing in CI | [`payments-lane` job](https://github.com/artisam-centient/centient/actions/runs/36382675655/job/108801484345) | ✅ |
| [D2 — Wallet-native onboarding](../deliverables/d2.md) | A recording of wallet connect → signed challenge → session issued, with no email or password | [D2 evidence folder](https://drive.google.com/drive/folders/1JS5hYQ-G4g-n92Hzf9RTNRBKWsUuvbFd?usp=drive_link) | ✅ |
| [D3 — End-to-end contributor loop](../deliverables/d3.md) | Live web app on Stellar testnet | [beta.centient.work](https://beta.centient.work) | ✅ |
| | A 3–5 minute demo of the rank → earn flow for a non-technical reviewer | The Week 4 demo, [Start here](#start-here) | ⏳ Recording in progress |
| | Payout transactions on stellar.expert | [`5975cdea…`](https://stellar.expert/explorer/testnet/tx/5975cdea767310fe789e61b5ac324b038bc48d5a0522009600b27a8d79343e93) and [`76486d20…`](https://stellar.expert/explorer/testnet/tx/76486d20cc69b691a5b6b5ae6fee7bc46c0e4648908711849b17a13bc0c411da) from D3 QA; 122 more in the volume proof | ✅ |
| | End-to-end tests passing in CI | [Run 36382675655](https://github.com/artisam-centient/centient/actions/runs/36382675655); see [CI lanes](#ci-lanes) | ✅ |
| [D4 — Reconciliation and public release](../deliverables/d4.md) | On-chain reconciliation report matching every payout to the ledger | [D4 volume proof](https://github.com/artisam-centient/centient/blob/develop/docs/superpowers/specs/2026-09-28-d4-volume-proof.md), the output of `npm run reconcile:report` | ✅ |
| | Mainnet config-flip smoke transaction | — | Out of scope (D-7) |

## Weekly expected outputs (§5.1)

| Week | Expected output | Evidence | Status |
| --- | --- | --- | --- |
| 1 | Payout account multisig threshold ≥ 2, verifiable on stellar.expert | [Payout account](https://stellar.expert/explorer/testnet/account/GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO) | ✅ |
| 1 | A real testnet USDC payout signed by two independent keys | [`5083dd72…`](https://stellar.expert/explorer/testnet/tx/5083dd72a16bfa749c6b302c293e931939acd70cc52f63586443921d60698206). The second key is the [policy co-signer](https://github.com/artisam-centient/centient/blob/develop/docs/cosigner-deployment.md), which re-derives the payout from the task ledger | ✅ |
| 1 | No single-key payout path anywhere in the codebase | [`no-single-key-payout.test.ts`](https://github.com/artisam-centient/centient/blob/develop/lib/stellar/__tests__/no-single-key-payout.test.ts) scans every Horizon submit site. [`key-custody.ts`](https://github.com/artisam-centient/centient/blob/develop/lib/stellar/key-custody.ts) refuses a deployment that holds threshold weight | ✅ |
| 1 | Daily-cap and cold-reserve refill runbooks in the repo | [Daily cap](https://github.com/artisam-centient/centient/blob/develop/docs/stellar-daily-payout-cap-runbook.md), [cold reserve](https://github.com/artisam-centient/centient/blob/develop/docs/stellar-cold-reserve-runbook.md) | ✅ |
| 1 | Payments-lane tests green in CI | [`payments-lane` job](https://github.com/artisam-centient/centient/actions/runs/36382675655/job/108801484345) | ✅ |
| 2 | Sign in with a Stellar wallet, no email and no password | [D2 evidence folder](https://drive.google.com/drive/folders/1JS5hYQ-G4g-n92Hzf9RTNRBKWsUuvbFd?usp=drive_link); [Freighter signing evidence](https://github.com/artisam-centient/centient/blob/develop/docs/superpowers/specs/2026-09-14-freighter-wallet-signing-evidence.json): a real SEP-53 signature, 7 of 7 checks, replay refused | ✅ |
| 2 | A zero-XLM wallet receives a sponsored USDC trustline and can accept USDC | [`b1ef0d3a…`](https://stellar.expert/explorer/testnet/tx/b1ef0d3aa2d3f74f7b86c3cbff840205718e76164b70e3774b5263a3051a435b), [`776cdee0…`](https://stellar.expert/explorer/testnet/tx/776cdee005e9e46ec990d877f87a024751700e1d5bac5dc83663919a033e4c54) | ✅ |
| 2 | Screen recording of connect → signed challenge → session issued | [D2 evidence folder](https://drive.google.com/drive/folders/1JS5hYQ-G4g-n92Hzf9RTNRBKWsUuvbFd?usp=drive_link) | ✅ |
| 2 | Identity-lane tests green in CI | [`build` job](https://github.com/artisam-centient/centient/actions/runs/36382675655/job/108801484451); see [CI lanes](#ci-lanes) | ✅ |
| 3 | Connect → rank → USDC in the connected wallet → reconciler confirms it on stellar.expert | [`5975cdea…`](https://stellar.expert/explorer/testnet/tx/5975cdea767310fe789e61b5ac324b038bc48d5a0522009600b27a8d79343e93) from QA's epic scenario, reconciled in the [D3 reconciler report](https://github.com/artisam-centient/centient/blob/develop/docs/superpowers/specs/2026-09-24-d3-reconcile-report.md) | ✅ |
| 3 | Only validated submissions pay; guard rejections logged and visible | [ADR-0004](https://github.com/artisam-centient/centient/blob/develop/docs/adr/0004-wallet-native-quality-guards.md). The volume proof counts 10 guard rejections, none of them paid | ✅ |
| 3 | Reconciler reports zero unreconciled payouts across the test run | [D3 reconciler report](https://github.com/artisam-centient/centient/blob/develop/docs/superpowers/specs/2026-09-24-d3-reconcile-report.md): 70 reconciled, 0 unreconciled | ✅ |
| 3 | End-to-end tests green in CI | [Run 36382675655](https://github.com/artisam-centient/centient/actions/runs/36382675655); see [CI lanes](#ci-lanes) | ✅ |
| 4 | ≥ 100 reconciled USDC payouts across ≥ 25 unique wallets | [D4 volume proof](https://github.com/artisam-centient/centient/blob/develop/docs/superpowers/specs/2026-09-28-d4-volume-proof.md): 122 to 25 | ✅ |
| 4 | Mainnet config-flip smoke payout | — | Out of scope (D-7) |
| 4 | Recorded demo, public testnet URL, runbook and API docs in the public repository | Demo: ⏳ recording in progress. [beta.centient.work](https://beta.centient.work), [runbooks](runbooks.md), [payout API](https://github.com/artisam-centient/centient/blob/develop/docs/payout-api.md) | ⏳ Demo only |
| 4 | CI green across all lanes; evidence package submitted | [Run 36382675655](https://github.com/artisam-centient/centient/actions/runs/36382675655) and this page. The package is final after the #53 release gate | ⏳ #53 |

## Security design (§3.8)

Each mitigation the SOW promised, and where it is proven.

| Risk | Evidence |
| --- | --- |
| Single-key compromise draining funds | The 2-of-3 payout account above, and the [co-signer deployment](https://github.com/artisam-centient/centient/blob/develop/docs/cosigner-deployment.md). The co-signer re-derives each payout from the ledger before it signs. It runs as its own Railway project in the same workspace, not in a separate cloud account ([ADR-0001](https://github.com/artisam-centient/centient/blob/develop/docs/adr/0001-simulated-cosigner-isolation.md)). [F-01](evidence.md#deliverable-1-transactions) records the one bypass found, which the custody guard now refuses |
| Bulk-reserve theft | The [cold reserve](https://stellar.expert/explorer/testnet/account/GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6), 2-of-3. A refill signed by two cold keys: [`3a5969cd…`](https://stellar.expert/explorer/testnet/tx/3a5969cdac22dad6646630c90cdb3ae3919a727f2abd8f663863b7e9e6b9ef3e). Float policy and worst-case loss: [cold reserve runbook](https://github.com/artisam-centient/centient/blob/develop/docs/stellar-cold-reserve-runbook.md) |
| Sybil and spam farming | [ADR-0004](https://github.com/artisam-centient/centient/blob/develop/docs/adr/0004-wallet-native-quality-guards.md): gold tasks, per-address rate limits and spam checks, keyed to the wallet |
| Double payment or sequence collisions | [Payout failure matrix](https://github.com/artisam-centient/centient/blob/develop/docs/payout-failure-matrix.md) (sequence collision, Horizon timeout); [ADR-0006](https://github.com/artisam-centient/centient/blob/develop/docs/adr/0006-journal-payout-envelopes.md) journals every envelope before submit. The volume proof finds 0 duplicates |
| Wallet-auth replay or impersonation | [Freighter signing evidence](https://github.com/artisam-centient/centient/blob/develop/docs/superpowers/specs/2026-09-14-freighter-wallet-signing-evidence.json); [`auth-challenge.ts`](https://github.com/artisam-centient/centient/blob/develop/lib/stellar/auth-challenge.ts) |
| Multisig hardening not finished in time | Not triggered. The automated co-signer shipped in Week 1, so the manual-signing fallback was never used |
| Testnet USDC issuer unavailable | Not triggered. Every payout is Circle's testnet USDC, issuer [`GBBD47IF…LFLA5`](https://stellar.expert/explorer/testnet/account/GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5) |
| Operational compromise and anomalies | Signing keys are service-scoped Railway variables, never committed. The daily cap is enforced at both signers ([runbook](https://github.com/artisam-centient/centient/blob/develop/docs/stellar-daily-payout-cap-runbook.md)), and the co-signer cap refusal is tested in the [failure matrix](https://github.com/artisam-centient/centient/blob/develop/docs/payout-failure-matrix.md). USDC and XLM low-balance alerts are described in the [failure runbook](https://github.com/artisam-centient/centient/blob/develop/docs/stellar-payout-failure-runbook.md) |

## Key outcome (§3.1)

What the SOW says anyone with a phone and a Stellar wallet can do at the end of the sprint.

| Outcome | Evidence |
| --- | --- |
| Connect a Stellar wallet and sign in, with no email and no password | [D2 evidence folder](https://drive.google.com/drive/folders/1JS5hYQ-G4g-n92Hzf9RTNRBKWsUuvbFd?usp=drive_link). Freighter only, as the extension or Freighter Mobile over WalletConnect v2 ([ADR-0003](https://github.com/artisam-centient/centient/blob/develop/docs/adr/0003-freighter-only-wallet-support.md)). Phones were QA'd on iOS; Android is untested |
| Rank pairs of AI responses in a mobile-friendly interface | [beta.centient.work](https://beta.centient.work); keyboard and screen-reader support in [D3](../deliverables/d3.md) |
| Receive USDC instantly for every validated contribution, with no XLM of their own | The 122 payouts in the [volume proof](https://github.com/artisam-centient/centient/blob/develop/docs/superpowers/specs/2026-09-28-d4-volume-proof.md), each fee-bumped by Centient |
| Verify each reward on stellar.expert | Every payout in the volume proof links to its transaction |

## CI lanes

The SOW names three test lanes. CI runs them as two jobs, so there is no job called *identity* or *end-to-end*. This is where each lane's tests live. Both jobs run on every pull request and on every merge to `develop`. `build` runs the whole suite, so the payments-lane files run there too.

| Lane | Job | Tests |
| --- | --- | --- |
| Payments | `payments-lane`, defined once in [`tests/payments-lane.ts`](https://github.com/artisam-centient/centient/blob/develop/tests/payments-lane.ts) | Multisig construction, co-signing, the daily cap, sequence-safe submission, the reconciler, and the [failure-injection suite](https://github.com/artisam-centient/centient/blob/develop/lib/__tests__/payout-failure-injection-db.test.ts) |
| Identity | `build` (`npm test`) | [`auth-challenge.test.ts`](https://github.com/artisam-centient/centient/blob/develop/lib/stellar/__tests__/auth-challenge.test.ts), [challenge route](https://github.com/artisam-centient/centient/blob/develop/app/api/auth/wallet/challenge/__tests__/route.test.ts), [`contributor-session.test.ts`](https://github.com/artisam-centient/centient/blob/develop/lib/__tests__/contributor-session.test.ts), [`sponsored-trustline.test.ts`](https://github.com/artisam-centient/centient/blob/develop/lib/__tests__/sponsored-trustline.test.ts) |
| End-to-end | `build` (`npm test`) | The loop, one stage at a time against a real database: submit queues a payout ([`payout-intent-db.test.ts`](https://github.com/artisam-centient/centient/blob/develop/app/api/submit/__tests__/payout-intent-db.test.ts)), the worker pays through both caps and the co-signer ([`payout-submission-rail-db.test.ts`](https://github.com/artisam-centient/centient/blob/develop/lib/__tests__/payout-submission-rail-db.test.ts)), and the reconciler matches it ([`payout-reconcile-db.test.ts`](https://github.com/artisam-centient/centient/blob/develop/lib/__tests__/payout-reconcile-db.test.ts)). No single test drives a real browser and wallet. That path is covered by each epic's manual QA gate |

## Still open

| Item | Owner | Closes |
| --- | --- | --- |
| The 3–5 minute demo video | Builder, #52 | When the link is added to [Start here](#start-here) |
| Deliverable 1's proof-of-deliverables PDF, with explorer captures | Builder | When it is uploaded next to the D2 recording. Everything it shows is already linked above |
| Epic 4's QA and release gate | #53, 1–2 October | `QA PASSED <sha>` at the final deployed SHA |

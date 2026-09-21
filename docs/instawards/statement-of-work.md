# Statement of Work

> Statement of Work for the Stellar Development Foundation Instawards program (Philippines chapter), submitted 22 July 2026 (v6). It is the reference for what the sprint delivers and how that is evidenced. It is reproduced verbatim and is **not edited to track the code**. Where the engineering work needed something the SOW did not describe, or narrowed something it did, that is recorded under [Decisions](reference/decisions.md#where-delivery-differs-from-the-sow) and in the weekly reports, not by changing this page.

***

## 1. Project & Team Information

| Field | Value |
| --- | --- |
| Project Name | Centient |
| Builder / Team Name | Centient |
| Primary Contact (Name + Email) | Carl Macabales — <carlmacabales31@gmail.com> |
| Ambassador Chapter | Philippines |
| Ambassador Chapter Lead | Nelson Lumbres |
| Date Submitted | 22-07-2026 |
| Suggested Sprint Start Date | 3 August 2026 |

## 2. Instawards Overview & Intent

### 2.1 Instawards Purpose (for Builder Context)

Instawards are designed to support short, clearly scoped, execution-focused work that helps a project make tangible progress toward building on Stellar. Instawards are meant to fund specific, achievable outcomes that can be completed and demonstrated within 30 days or less. This SOW represents a shared commitment between the Builder and the Ambassador Chapter Lead on what will be delivered, why it matters, and how success will be verified.

## 3. Problem Statement & Objective

| | | |
| --- | --- | --- |
| **Problem Being Addressed** | *What specific problem, gap, or blocker is this Instaward intended to solve?* | High-quality AI evaluation depends on human judgment — deciding which of two AI-generated responses is more accurate, safer, clearer, or better aligned with what the user actually intended. That human preference signal does not exist in raw model output; it lives only in people's heads and must be collected from them. Today this work is slow and expensive, locked inside centralized labeling vendors with opaque quality and limited global reach, and the people who produce it are paid slowly, opaquely, and weeks in arrears. There is no open, instantly-rewarding, globally-accessible way for everyday people to contribute human preference rankings and be paid fairly, in real time, for each validated contribution. |
| **Objective of This Instaward** | *In one or two sentences, what will be true at the end of 30 days if this Instaward is successful?* | Prove an end-to-end workflow on Stellar Testnet: a contributor connects a Stellar wallet, completes AI response-ranking tasks, and receives a direct USDC (a USD stablecoin) micro-reward for every submission that passes Centient's validation rules — no email, no bank, and no XLM of their own. The full loop runs live and verifiable on testnet, with the operator sponsoring all network fees and account reserves during the MVP so contributors never pre-fund their wallets, and is flippable to mainnet by configuration only. |

*Example prompts for builders: What is currently preventing progress? What is unclear, missing, or unbuilt today? Why is this problem worth solving now?*

### 3.1 Key Outcome

At the end of this sprint, anyone with a phone and a Stellar wallet can:

1. Connect a Stellar wallet (Freighter / Albedo) and sign in — no email, no password.
2. Rank pairs of AI-generated responses through a simple, mobile-friendly interface.
3. Instantly receive USDC (a USD stablecoin) in their own wallet for every validated contribution — with no XLM of their own required.
4. Independently verify each reward on-chain via stellar.expert.

No manual payment coordination, no bank account, no XLM to hold, and no custody required.

### 3.2 The Gap & Traditional Rails

Producing high-quality human preference data depends on human judgment that is slow and costly to collect at scale, and contributors are typically paid slowly, opaquely, and weeks in arrears — killing the incentive loop that drives volume and quality. Traditional rails fail for global micro-rewards:

| Alternative | Key Limitation |
| --- | --- |
| Bank / processor payouts | Minimum-cashout thresholds and per-transfer fees erode micro-rewards; exclude billions of unbanked people. |
| PayPal / gig & survey platforms | Frequent account freezes, geographic restrictions, and slow payouts that break the instant-reward loop. |
| Ethereum / EVM rails | Gas fees often exceed the reward itself — micro-rewards are economically dead. |

### 3.3 Why Stellar & Ecosystem Impact

Stellar is uniquely suited to Centient's model: rewards are very small and need to settle within seconds; contributors should not need a bank account or a traditional payout rail; contributors should not have to pre-fund gas fees; and USDC gives them a stable, USD-denominated reward. Stellar's low-cost, fast, self-custodial micropayments fit this exactly. Centient pays contributors in USDC while the operator pool funds every network fee and account reserve in XLM, so contributors receive full value with zero XLM overhead:

* **Near-zero fees (<$0.01):** each USDC reward reaches the contributor intact — Centient absorbs the sub-cent XLM fee, so nothing is eroded.
* **Fast finality:** USDC arrives in the contributor's wallet in seconds, the moment a task is validated.
* **On-chain growth:** every settlement creates a funded Stellar wallet, a USDC trustline, and a verifiable on-chain USDC transfer — measurable activity on the network.
* **New users & use case:** onboards non-crypto-native data labelers into self-custodial wallets and positions Stellar as settlement for the AI training-data economy.

### 3.4 Existing Approaches

Stellar's own tooling addresses a different payment shape. The Stellar Disbursement Platform (SDP) is purpose-built for batch, operator-initiated bulk disbursement — an organization uploads a recipient list and pushes scheduled payment runs. Centient needs the opposite rail: a per-task, event-triggered instant micro-payout fired at the exact moment a single ranking is validated, with the contributor's own wallet as both identity and destination and the operator absorbing every fee. That per-event, sub-cent, self-custodial settlement pattern is a different problem than scheduled batch disbursement, which is why Centient builds a dedicated instant-payout engine rather than adopting SDP.

| Platform | Primary Focus |
| --- | --- |
| Centralized labeling vendors (Scale AI, Surge AI, Appen, Toloka) | Opaque quality, high overhead, limited global reach, and slow payouts with no verifiable proof of compensation. |
| Gig & survey platforms (Amazon Mechanical Turk, Prolific, Clickworker) | Generalized microtasks on traditional rails; payouts gated behind banks and high minimum-cashout thresholds. |
| Crypto-native data platforms (Ocean Protocol, Bittensor subnets) | Token-denominated rather than stable per-task compensation; reward value swings with the token, and EVM/L1 gas costs break micro-reward economics. Oriented to data markets and model competition rather than human preference ranking. |
| Stellar Disbursement Platform (SDP) | Batch, operator-initiated bulk disbursement: upload a recipient list and push scheduled payout runs. Built for periodic mass payments, not per-task, event-triggered instant micro-rewards fired the moment a single contribution is validated. |
| Centient | Instant USDC (stablecoin) rewards on Stellar for human-ranked AI data, with self-custodial wallet identity, operator-funded fees, and on-chain proof of every payout. |

### 3.5 Go-To-Market & Partner Alignment

Centient is positioned as the human-judgment layer of the Stellar AI economy. Rather than promising signed integrations inside a 30-day sprint, this Instaward builds the technical foundation those integrations require: a verifiable USDC reward rail, self-custodial wallet identity, and on-chain proof of every payout. Each partner below can evaluate integration against a live testnet system at the end of the sprint.

| Partner | Description | How Centient integrates |
| --- | --- | --- |
| Paiflow | A visual, non-custodial payment-flow builder on Stellar / Soroban, with a developer API for splitter and swapper flows. | Centient can call Paiflow's machine-facing API to trigger on-chain payout flows rather than extending its own payout logic. Paiflow's Instaward SOW names Centient as a target integration, so the dependency runs both ways within the Philippines chapter. |
| Ember | A milestone-based, on-chain crowdfunding dApp on Stellar. | Shared self-custodial contributor identity and reward-settlement patterns. Centient's validated-task trigger can release milestone-linked bounties on the same rails. |
| AI research teams & labs | Buyers of human-ranked preference data for model alignment and evaluation. | Per-task USDC settlement replaces slow vendor invoicing. This sprint delivers the verifiable payout rail those buyers require before any dataset commitment. |

Sequencing after the sprint: (1) open the testnet build to the Philippines chapter for contributor volume, (2) run a Paiflow API integration spike against the live reward rail, (3) move to mainnet by configuration and onboard a first paying data buyer.

### 3.6 Validation Scope & Practical Use Cases

**Validation Scope:** Centient validates that a completed, quality-checked ranking task triggers a real, instant USDC payout confirmed on-chain, that wallet-connect identity works as both login and payout destination, and that the system is flippable from testnet to mainnet by configuration only. It does not curate dataset buyers or run a marketplace in this scope.

**Target Users:** Centient's labeling app, quality guards, and reconciler are already built and live on testnet from prior work — the technical foundation exists, even though no contributors have used it yet. This sprint's ≥25-wallet adoption target is a cold-start goal: onboarding a first contributor base onto the wallet-native, instant-payout flow from zero. Target users are twofold: (1) contributors — Stellar Philippines chapter members and \[target community, e.g. Discord/Telegram group to launch with] who will be onboarded fresh; and (2) AI research teams sourcing human-preference data, who need a verifiable per-task settlement rail before committing to a dataset relationship.

This sprint also changes how rewards reach contributors. The current build accumulates each reward as an off-chain balance that the contributor withdraws later to a separately-bound wallet address. That model is replaced here by "wallet is identity and destination": the connected Stellar wallet signs in and instantly receives USDC per validated task, with no custodial balance and no separately-typed payout address.

**Use Cases:**

* **Global earning:** a contributor in an emerging market ranks AI responses on their phone during a commute and earns USDC instantly — no bank account and no XLM required.
* **AI data sourcing:** a research team sources diverse, human-ranked preference data and pays per-task in real time instead of via slow vendor invoices.
* **Ecosystem onboarding:** a new Stellar wallet user discovers a real earn use case that brings recurring micro-transactions onto the network.

### 3.7 Sprint Constraints & Targets

* **Open & accessible:** the repository is public today at <https://github.com/cemmacabales/centient> — anyone can clone and inspect it now, not a week-4 promise. The public testnet URL ships with the Week 4 evidence package.
* **Adoption target:** ≥ 25 unique Stellar wallets complete the rank → earn flow.
* **Transaction target:** ≥ 100 on-chain USDC payouts on testnet, plus ≥ 1 mainnet smoke payout.
* **Technical target:** reward rail, wallet identity, labeling app, and on-chain reconciliation all live with zero unreconciled payouts.
* **Why Instawards:** focuses purely on a reusable 30-day execution POC, not an open-ended marketplace.

### 3.8 Security & Risk Considerations

Payouts are architected with no single point of failure. Contributor funds are never controlled by a single key: the payout account uses native Stellar multisig, an independent policy co-signer must add a second signature before any payment settles, and the bulk reserve is held in a separate multisig cold wallet under hot/cold separation — so no single key or server compromise can move user funds.

| Risk | Mitigation |
| --- | --- |
| Single-key compromise draining user funds | No single key can move funds. The payout account uses native Stellar multisig (2-of-N): the payout service builds each transaction, and an independent policy co-signer adds the second signature only after re-validating the task and the daily cap. That co-signer is operationally independent — separate cloud account, deploy pipeline, and key store — and re-derives each payout from Centient's own task ledger rather than trusting the payout service's request, so an attacker must compromise two isolated systems to forge a payment. Compromising any one key or server cannot move funds. |
| Bulk-reserve theft | Hot/cold separation. The always-online hot wallet holds only a bounded daily operational float; the reserve sits in a separate multisig cold wallet (2-of-3) whose signers live on isolated infrastructure and only sign scheduled refills. Worst-case hot-wallet loss is capped at the float, never the reserve. |
| Sybil / spam farming for rewards | Quality guards: gold-standard tasks, per-address rate limiting, and spam detection. Only validated submissions trigger payouts. |
| Double-pay or sequence collisions under load | Sequence-safe transaction submission and stroops-precision accounting; an on-chain reconciler detects and prevents duplicate or unreconciled payouts. |
| Wallet-auth replay / impersonation | Passwordless login via one-time signed challenge; sessions keyed to the proven Stellar address; no custody of contributor keys. |
| Multisig hardening not complete within the 30-day window | Week 1 is sequenced security-first so the multisig path is proven before any feature work. If the automated policy co-signer cannot be fully hardened inside the sprint, the fallback is a 2-of-3 native Stellar multisig on the payout account with the second signature applied from isolated infrastructure under a documented runbook and a hard daily cap, with the automated co-signer delivered as a documented follow-on. Under no fallback does a single key gain the ability to move contributor funds. |
| USDC issuer or trustline unavailable on testnet | The reward asset is configuration-driven, not hard-coded. If the Stellar testnet USDC issuer is unavailable or unstable during the sprint, the fallback is a Centient-issued test stablecoin on testnet for the volume runs, with the mainnet config-flip smoke payout executed in Circle USDC over the identical code path. Asset choice does not affect the multisig architecture or the reconciliation guarantees. |
| Operational compromise / anomalies | Signing keys are injected at runtime from a managed secrets store and never committed to the repo; because no single key can move funds (see multisig above), a leaked key on its own cannot forge a payout. A configurable daily payout cap is enforced independently at both signers; low-balance and anomaly alerts run on both the USDC reward balance and the XLM fee/reserve balance; the mainnet pool is funded only to operational minimums. |

### 3.9 How It Works

```
Contributor connects a Stellar wallet & signs a one-time challenge (identity)
                                  ↓
Centient serves AI response pairs; contributor ranks the better one
                                  ↓
Quality guards validate the submission (gold-standard tasks, agreement thresholds,
rate limiting, spam detection)
                                  ↓
Independent policy co-signer re-validates the task & daily cap, then co-signs
(native Stellar multisig)
                                  ↓
Multisig hot wallet submits the instant USDC payment via Horizon; Centient pays
the fee in XLM (bounded float, stroops precision)
                                  ↓
On-chain reconciler confirms the payout — verifiable on stellar.expert

Reserve held in a separate multisig cold wallet; it refills the hot float only via
multisig-approved transfers.
```

On first connect, Centient sponsors the contributor's USDC trustline and pays the fee in XLM — the contributor signs once and never needs to hold XLM.

## 4. Scope of Work (30-Day Deliverables)

*Important guidance: This scope must be achievable within 30 calendar days. If the work feels larger, it should be reduced or split into more achievable phases.*

### 4.1 In-Scope Deliverables

**What already exists, and what this sprint builds.** The end-to-end labeling app, quality guards, and on-chain reconciler are already live on Stellar testnet from prior work — the retroactive impact Instawards explicitly credit. The new build this sprint is the delta on top of that foundation: the multisig security architecture (independent policy co-signer plus hot/cold separation with a reserve-reclaim job), wallet-native login, instant per-task USDC payout, fee-bump sponsorship, and the public release. Deliverables 3 and 4 are therefore re-wiring and hardening work rather than new construction, and the budget and timeline in Sections 4.2 and 5.1 are weighted accordingly — the majority of the sprint funds the new security and payout architecture, not the components already shipped.

| Deliverable | Description (What will be built or produced?) | Why this matters |
| --- | --- | --- |
| **Deliverable 1** — Instant USDC Reward Rail on Stellar | A USDC payout engine with no single point of failure: every validated task triggers an instant USDC payment from a multisig hot wallet (native Stellar 2-of-N), co-signed by an independent policy service that re-verifies the task and enforces a configurable daily cap before the second signature is added. Centient pays every network fee in XLM (fee-bump) so contributors receive USDC intact. The bulk reserve sits in a separate multisig cold wallet and refills the hot float only via multisig-approved transfers, bounding worst-case loss. Includes stroops-precision accounting, sequence-safe submission under load, and dual-asset wallet-health monitoring (USDC + XLM) with low-balance/anomaly alerts. | The instant-reward engine — the moment of value that makes contributing feel worthwhile and keeps people coming back. |
| **Deliverable 2** — Wallet-Native Contributor Onboarding | Passwordless onboarding via Stellar wallet-connect (Freighter / Albedo): the contributor signs a one-time challenge to prove ownership of their address and receives a session. On first connect, Centient sponsors their USDC trustline reserve and pays the fee in XLM (sponsored reserves + fee-bump), so the contributor signs a single trustline op and needs no XLM of their own. Their Stellar address is both their identity and their USDC payout destination — no email, no bank, no custody. | Frictionless, self-custodial access — anyone with a Stellar wallet can start earning in seconds, anywhere. |
| **Deliverable 3** — End-to-End Contributor Experience | The full contributor experience on Stellar: connect a wallet, rank AI response pairs, and instantly receive USDC — protected by built-in quality guards (gold-standard tasks, rate limiting, spam detection) that keep the output data high-fidelity. (Already live on Stellar testnet from prior work; this sprint hardens it and re-wires the loop from custodial accumulate-then-withdraw to instant per-task payout.) | Proves the whole loop — human judgment in, high-fidelity data out, instant on-chain reward — works as one usable product. |
| **Deliverable 4** — On-Chain Reconciliation and Public Release | An on-chain reconciler that confirms every payout against the ledger, delivered live on testnet with a recorded end-to-end demo and a public URL — proven flippable to mainnet by configuration via a real mainnet smoke payout. (The reconciler is already live from prior work; this sprint extends it to the multisig instant-payout path and adds the public mainnet config-flip smoke.) | Verifiable, auditable proof that every reward settled on Stellar, and that the system is mainnet-ready. |

#### Out-of-Scope (Explicitly Not Included)

*List anything that might be assumed but is not included in this Instaward scope.*

* A Soroban-based payout contract. Planned as the next-stage decentralization path beyond this POC; native Stellar multisig delivers equivalent no-single-point-of-failure safety today, without contract-audit risk.
* Third-party formal security audit. The multisig configuration ships with internal tests, on-chain threshold verification, and team review only.
* Custodial contributor balances and withdrawal flows.
* Multi-asset payouts beyond USDC; channel-account payout parallelism; HSM-based key custody.
* Native mobile (iOS / Android) apps. The web app is responsive but no binary is shipped.
* Enterprise data-buyer dashboards, dataset-export, or marketplace tooling.
* Token issuance, governance, or DAO mechanics. Centient has no token and will not have one.
* Multi-chain support. Stellar only.
* Localisation. English only.
* Production SLA or uptime guarantees on the public demo URL.
* SaaS subscriptions, hardware, runway or emergency funds, liquidity, reserves, or operational expenses. The entire budget request is development labor.

Rewards are paid in USDC (Circle's Stellar-native stablecoin); Centient funds all network fees and account reserves in XLM.

### 4.2 Deliverable-Aligned Budget Request

| Requested Budget Amount | Rationale for Budget Request |
| --- | --- |
| $5,000 | 30 days full-time solo development. The labeling app, quality guards, and reconciler are already live on testnet, so this budget funds the delta rather than the whole product: the multisig reward rail, wallet-connect identity, the re-wire from custodial balances to instant per-task payout, and the hardened public release. Weeks are weighted to match — the new security architecture and hardening carry the load; the already-shipped components carry the smallest allocation. |

Developer pay per task:

* **Week 1** — Multisig reward rail, independent policy co-signer, hot/cold reserve separation (new build): **$1,500** (48–52 hrs @ $28.85–$31.25/hr)
* **Week 2** — Wallet-connect identity, sponsored USDC trustline, fee-bump (new build): **$1,250** (40–45 hrs @ $27.78–$31.25/hr)
* **Week 3** — Re-wiring the existing labeling app, quality guards, and reconciler onto the instant multisig payout path (adaptation of shipped components): **$875** (28–32 hrs @ $27.34–$31.25/hr)
* **Week 4** — Hardening, failure testing, threshold verification, mainnet smoke test, public release, demo and evidence: **$1,375** (44–48 hrs @ $28.65–$31.25/hr)

The entire budget is software-development labor. Testnet and mainnet infrastructure, pooled wallet funding, Horizon access, monitoring, tooling, and any overtime are shouldered by the builder at no cost to this Instaward.

This establishes Centient's foundation on Stellar and unlocks the next stage: mainnet scale, a dataset marketplace for AI buyers, and multi-asset payouts.

## 5. 30-Day Execution Plan & Timeline

### 5.1 Weekly Breakdown

| Week | Planned Work | Expected Output |
| --- | --- | --- |
| **Week 1** | • Configure the payout account for native Stellar multisig (2-of-N); verify signers and thresholds on-chain.<br>• Build the payout service: transaction construction, stroops-precision accounting, sequence-safe submission under load.<br>• Build the independent policy co-signer on a separate cloud account, deploy pipeline, and key store; it re-derives each payout from the task ledger before signing.<br>• Enforce the configurable daily payout cap independently at both signers.<br>• Stand up hot/cold separation: a 2-of-3 multisig cold reserve refilling the hot float only via multisig-approved transfers.<br>• Wire dual-asset wallet-health monitoring (USDC reward balance + XLM fee/reserve balance) with low-balance and anomaly alerts.<br>• De-risking spike: fund a testnet account via friendbot, sponsor a USDC trustline, send a real multisig-signed USDC payment with the fee paid in XLM.<br>• Unit tests for the signing and cap-enforcement paths. | • Payout account multisig threshold ≥ 2, verifiable on stellar.expert.<br>• A real testnet USDC payout signed by two independent keys, tx hash on stellar.expert.<br>• No single-key payout path exists anywhere in the codebase.<br>• Daily-cap and cold-reserve refill runbooks committed to the repo.<br>• Payments-lane tests green in CI. |
| **Week 2** | • Freighter / Albedo wallet-connect integration in the web app.<br>• One-time signed-challenge authentication; sessions keyed to the proven Stellar address, with replay protection and expiry.<br>• Sponsored-reserve flow: Centient sponsors the contributor's USDC trustline reserve.<br>• Fee-bump wrapper so the contributor signs a single trustline operation and never needs to hold XLM.<br>• Handle the unfunded-wallet edge case by sponsoring account creation for a brand-new address.<br>• Integration tests for the auth and sponsorship paths. | • A user connects a Stellar wallet and signs in with no email and no password — their address is their identity.<br>• A brand-new wallet holding zero XLM receives a sponsored USDC trustline and can accept USDC.<br>• Screen recording of connect → signed challenge → session issued.<br>• Identity-lane tests green in CI. |
| **Week 3** | • Adapt the existing ranking interface to the wallet-native session: AI response pairs, mobile-first layout, keyboard-accessible controls.<br>• Re-wire the submission pipeline from custodial accumulate-then-withdraw to instant payout: rank → validate → co-sign → pay → reconcile.<br>• Re-scope the existing quality guards to the connected address: gold-standard tasks, per-address rate limiting, spam detection.<br>• Extend the existing on-chain reconciler to the multisig instant-payout path; it matches every payout against the ledger and flags duplicates or unreconciled entries.<br>• Add idempotency-safe retries so a resubmitted task cannot double-pay.<br>• End-to-end integration test covering the full contributor loop. | • Connect → rank → receive USDC in the connected wallet → reconciler confirms the payout on stellar.expert.<br>• Only validated submissions trigger payouts; guard rejections logged and visible.<br>• Reconciler reports zero unreconciled payouts across the test run.<br>• End-to-end tests green in CI. |
| **Week 4** | • Verify multisig thresholds on both hot and cold wallets and capture the on-chain evidence.<br>• Failure testing: sequence collisions, co-signer unavailable, daily cap exceeded, Horizon timeout.<br>• Harden error handling; final tuning of low-balance and anomaly alerts.<br>• Run the mainnet config-flip smoke test — one small real USDC payout.<br>• Record the 3–5 minute end-to-end demo for a non-technical reviewer.<br>• Publish the runbook and API docs to the already-public repo, and publish the public testnet URL.<br>• Collect evidence: account addresses, tx hashes, reconciler output, screen recordings.<br>• Final typecheck and CI pass across all lanes; prepare the evidence handoff for the Ambassador Chapter Lead. | • Hardened testnet build with ≥ 100 reconciled USDC payouts across ≥ 25 unique wallets.<br>• Successful mainnet config-flip smoke payout, tx hash on stellar.expert.<br>• Recorded demo video, public testnet URL, and runbook and API docs in the public GitHub repository.<br>• CI green across all lanes; evidence package submitted. |

## 6. Evidence of Completion (Required)

*Important guidance: Evidence should be clear, verifiable, and easy to review by the Ambassador Chapter Lead with minimal technical expertise.*

### 6.1 Planned Evidence to Be Submitted

| Deliverable | Evidence Type | Description |
| --- | --- | --- |
| Deliverable 1 | GitHub repo + testnet tx hash | Payment service in the repo. A Horizon payout transaction hash on stellar.expert (testnet) showing a USDC reward reaching a contributor with the fee paid in XLM by Centient, signed by two keys — plus the payout account's multisig signers/thresholds (threshold ≥ 2) verifiable on-chain, and the payments-lane test suite passing in CI. |
| Deliverable 2 | GitHub repo + screen recording | A short recording of Stellar wallet connect → signed-challenge → session issued for a contributor's address, with no email or password. |
| Deliverable 3 | Public URL + demo video + tx hashes | Live web app on Stellar testnet. A 3–5 min demo of the full rank → earn flow for a non-technical reviewer, plus payout transactions on stellar.expert and the end-to-end test suite passing in CI. The repository is already public at <https://github.com/cemmacabales/centient>. |
| Deliverable 4 | Reconciler output + mainnet tx hash | On-chain reconciliation report matching every payout to the ledger, plus the mainnet config-flip smoke-test transaction on stellar.expert. |

### 6.2 Evidence Verification Checklist (For Ambassador Use)

For each deliverable, the Ambassador Chapter Lead will assess whether evidence is present and sufficient.

| Deliverable | Evidence Present | Evidence Partial | Evidence Missing | Comments |
| --- | --- | --- | --- | --- |
| Deliverable 1 | | | | |
| Deliverable 2 | | | | |
| Deliverable 3 | | | | |
| Deliverable 4 | | | | |

### 6.3 Success Metrics

| Metric | Target |
| --- | --- |
| Successful USDC reward settlements on testnet | ≥ 100 |
| No single-key payout path (payout account multisig threshold ≥ 2), verifiable on-chain | Yes |
| Contributors receive USDC with no XLM of their own (sponsored trustline + fee-bump) | Yes |
| Unique Stellar wallet addresses onboarded | ≥ 25 |
| Successful mainnet config-flip smoke payout | ≥1 |
| Automated test suites green in CI (payments, identity, end-to-end) | Yes |
| Unreconciled payouts | 0 |
| Public testnet URL live & accessible | Yes |
| Demo video published | Yes |
| Public GitHub repository released | Yes — already public |

## 7. Next-Step Alignment

### 7.1 Anticipated Next Step After Completion

After this Instaward, the most likely next step is:

* ☑ Apply to SCF Build Award
* ☑ Continue development independently
* ☑ Apply for a follow-on Instaward (if eligible)
* ☑ Seek other ecosystem support
* ☐ Other: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_

## 8. Instawards Constraints Acknowledgement

By submitting this SOW, the Builder acknowledges:

* ☑ This scope will be completed within 30 days or less.
* ☑ Instawards support execution, not open-ended exploration.
* ☑ A project may receive no more than two follow-on Instawards.
* ☑ Each Instaward is capped at $5,000.
* ☑ Total Instawards funding may not exceed $15,000.

## 9. Submission Confirmation

Once finalized, this Statement of Work will be submitted by the Ambassador Chapter Lead via the Instawards Airtable submission form for review and approval.

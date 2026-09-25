# Decisions

Every decision that changed scope, topology or process during the sprint, with the reason and where it is recorded. Architecture decisions are kept as ADRs in the repository. Owner decisions on review questions are numbered D-*n*.

## Where delivery differs from the SOW

The Statement of Work is never edited. Every place the delivered system departs from its text is listed here, with the reason and what closes the gap.

| SOW text | What was delivered | Why | Closes when |
| --- | --- | --- | --- |
| §1: suggested sprint start **3 August 2026** | The sprint started **7 September 2026** and runs 30 days, to 6 October | Program start date | — |
| §3.8, §5.1 Week 1: the co-signer runs on a **"separate cloud account, deploy pipeline, and key store"** | The co-signer runs as its own Railway project **in the same workspace**: its own container, service-scoped variables, deploy trigger and member list, HMAC transport and a read-only ledger role. It does **not** have its own account, repository, CI or database instance | Waiting on an external billing and ownership approval would have blocked Week 1 for a rail with zero value at risk ([ADR-0001](https://github.com/cemmacabales/centient/blob/develop/docs/adr/0001-simulated-cosigner-isolation.md)). The co-signer is still the automated one; §3.8's manual-signing fallback was not needed | Before the mainnet smoke payout. `same-workspace` refuses to sign on mainnet, so this is enforced rather than remembered |
| §3.1, §4.1, §5.1: **"Freighter / Albedo"** | **Freighter only** | Albedo could not prove ownership or co-sign in the existing code, and supporting it would have doubled the QA matrix. No §6 evidence item names a particular wallet ([ADR-0003](https://github.com/cemmacabales/centient/blob/develop/docs/adr/0003-freighter-only-wallet-support.md)) | Reopen criteria are in ADR-0003 |
| §3.1: **"anyone with a phone and a Stellar wallet"** | A phone signs in with the **Freighter Mobile app over WalletConnect v2** (#134, #135, #140, #142). A desktop uses the Freighter browser extension, or scans a QR code with the app. Still Freighter only | ADR-0003 left phones out; the D-4 ruling (22 Sep) brought them into Deliverable 3 | **Met on iOS** in the Epic 3 QA gate (#41, passed 24 Sep). The phone gate was ruled iOS-only, so Android is an untested residual |
| §4.1: a **reserve-reclaim job** | Reclaim is an **operator-run command**, with dry run as the default, not a scheduled job | Revocation fails on-chain for owners holding no XLM, which is most contributors, so an unattended schedule would mostly produce failures (D-1) | Accepted as delivered |
| §4.1, §5.1 Week 2: the contributor **"signs a single trustline op"** | The contributor gives **one signature**. It covers two operations sourced from their account: `changeTrust` and `endSponsoringFutureReserves`. The latter is how Stellar sponsorship works | Protocol requirement | Accepted as delivered |
| §3.8: signing keys **"injected at runtime from a managed secrets store"** | Keys are Railway service-scoped variables, injected at runtime and never committed. There is no separate vault integration | Pre-mainnet | Mainnet key provisioning (R-5) |
| §3.7: the public testnet URL **"ships with the Week 4 evidence package"** | [centient.work](https://centient.work) has been **live throughout the sprint** | Ahead of plan | — |
| §3.6: *"[target community, e.g. Discord/Telegram group to launch with]"* | The contributor community is still to be named | The placeholder was never filled in | Tester recruitment for the ≥25-wallet target (R-3) |

## Architecture decision records

| ADR | Decision | Status | Consequence |
| --- | --- | --- | --- |
| [ADR-0001](https://github.com/cemmacabales/centient/blob/develop/docs/adr/0001-simulated-cosigner-isolation.md) | The policy co-signer runs in **its own Railway project inside the existing workspace**, simulating the account boundary with every boundary Railway and Postgres can enforce | Accepted, 8 Sep | Meets *server* isolation, not *account* isolation. `same-workspace` fails closed on mainnet, so a separate account is required before #51 |
| [ADR-0002](https://github.com/cemmacabales/centient/blob/develop/docs/adr/0002-seeded-credentials-accepted-on-testnet-qa.md) | Seeded QA credentials are **accepted for the internal testnet QA pass** | Accepted, 9 Sep | Holds explicit exit criteria that must be met before any wider exposure |
| [ADR-0003](https://github.com/cemmacabales/centient/blob/develop/docs/adr/0003-freighter-only-wallet-support.md) | **Freighter only**; Albedo is descoped from Deliverable 2 | Accepted, 14 Sep; amended 22 Sep | The QA matrix halves. The amendment records that the mobile gap is closed by Freighter Mobile over WalletConnect v2, which is a second transport for Freighter and not a second wallet |

## Owner decisions

| ID | Question | Decision | Date |
| --- | --- | --- | --- |
| — | Should the cap-alert ordering defect found in #9 get its own issue? | No. It is **fixed inside #12**, whose commit target rose from 7 to 8 | 8 Sep |
| — | Should the unmerged #6 review branch be kept? | **Discarded.** The self-sponsoring recipient guard is therefore not in the codebase. If it is wanted, it is new work | 7 Sep |
| — | Package manager? | **npm** with the committed `package-lock.json` is the CI and install authority | 7 Sep |
| D-1 | How does reserve reclaim run? | Operator-run, **dry run by default**, and revokes only where the owner can absorb the reserve | 15 Sep |
| D-2 | Per-IP challenge throttle | 5/min per address, 20/min per IP (#109) | 15 Sep |
| D-3 | Wallet rotation | **Out of D2**, recorded as a known limitation | 15 Sep |
| D-4 | Mobile through Freighter + WalletConnect | **In scope for Deliverable 3**, verified in the Epic 3 QA gate (#41) against #137. The "before #35" deadline lapsed without a ruling; it was decided after the path had shipped (ADR-0003 amendment) | Raised 15 Sep, decided 22 Sep |
| D-5 | What counts as QA approval? | The **`QA PASSED <full-tested-sha>` comment** on the gate issue. A label alone never approves | 15 Sep |
| D-6 | PostHog backend capture, a staging subdomain, email notifications | **Not D2 scope.** Each gets its own issue if still wanted | 15 Sep |
| — | Existing email accounts | Email registration is retired (`410`). An existing email account claims a wallet and then signs in with it, and cannot earn or withdraw before the claim | 15 Sep |

## Process decisions

| Decision | Why |
| --- | --- |
| **Development is manual.** The builder implements each issue by hand on a dedicated branch. There is no agent dispatch anywhere in the program | Removed the Codex `agent-ready` automation on Day 1 (PR #61) |
| **Exactly one implementation issue in flight at a time**, and a successor starts only after its predecessor merges | Keeps each change reviewable and the dependency chain honest |
| **One QA gate per epic**, against one frozen SHA | Per-issue QA does not fit a three-day development window; a single pass on the final build does |
| **The single-contributor rule is enforced by CI** | Every authored commit belongs to the builder, with no bot or AI co-author attribution. Merge commits are exempt (PR #83) |

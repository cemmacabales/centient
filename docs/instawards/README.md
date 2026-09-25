# Centient — Instawards

Weekly milestone reports for the Stellar Development Foundation Instawards program (Philippines chapter). Each week records what shipped, links every [Statement of Work](statement-of-work.md) item to the commits and on-chain transactions that prove it, and updates the success metrics.

| | |
| --- | --- |
| **Project** | Centient: a human-feedback platform that pays contributors in USDC on Stellar, the moment their work is validated |
| **Builder** | Carl Macabales ([@cemmacabales](https://github.com/cemmacabales)) |
| **Chapter** | Philippines. Chapter Lead: Nelson Lumbres |
| **Sprint** | 7 September – 6 October 2026 (30 days). Four weekly deliverables, with delivery completing Saturday 3 October |
| **Live app** | [beta.centient.work](https://beta.centient.work), served from the `staging` branch on Stellar **testnet** |
| **Source** | [github.com/artisam-centient/centient](https://github.com/artisam-centient/centient), the public repository. It mirrors the development repository at identical commit SHAs |
| **Network** | **Testnet only.** Nothing in this sprint touches mainnet (D-7) |
| **Budget** | $5,000, all development labor (SOW §4.2) |

## Evidence checklist (SOW §6.2)

Where each deliverable's §6.1 evidence stands today. Each row links to its deliverable page, which has the full traceability table.

| Deliverable | Evidence | Status | Comments |
| --- | --- | --- | --- |
| [D1](deliverables/d1.md) | GitHub repo + testnet tx hash | ✅ **Present** | A two-signature, fee-bumped USDC payout on stellar.expert; payout account at threshold 2/2/2; payments lane green in CI. QA passed 28/28 |
| [D2](deliverables/d2.md) | GitHub repo + screen recording | ✅ **Present** | Code, testnet sponsorship and identity tests are all present, and QA passed at `8f660cc`. The connect → signed challenge → session recording and proof are in the [D2 evidence folder](https://drive.google.com/drive/folders/1JS5hYQ-G4g-n92Hzf9RTNRBKWsUuvbFd?usp=drive_link) |
| [D3](deliverables/d3.md) | Public URL + demo video + tx hashes | 🟡 **Partial** | The public URL is live, and instant per-answer payouts are on stellar.expert. QA passed at `1fde77d`. The demo video comes in Week 4 |
| [D4](deliverables/d4.md) | Reconciler output + mainnet tx hash | ⬜ Week 4 | The reconciler output comes from the Week 4 volume run. The mainnet transaction is out of scope: the sprint is testnet only (D-7) |

## What Centient is

Good AI depends on human judgment: a person deciding which of two answers is more accurate, safer or clearer. Centient collects that judgment. A **contributor** compares a pair of AI responses, picks the better one and says why. Quality guards check the submission, and a validated submission pays a USDC **reward** straight to the contributor's own Stellar wallet.

When the sprint is finished, a contributor:

1. connects a Stellar wallet, which serves as both sign-up and sign-in,
2. ranks a pair of AI responses,
3. passes the quality guards,
4. receives USDC in that same wallet within seconds, and
5. can check the payment on [stellar.expert](https://stellar.expert/explorer/testnet).

They need no email, no password, no bank account and no XLM of their own.

## What this sprint changes

The labeling product already ran before the sprint. The sprint changes **how money moves** and **how people sign in**:

| Before the sprint | After the sprint |
| --- | --- |
| One platform key could move all contributor funds | A 2-of-3 multisig payout account. An independent policy co-signer re-checks every payout before it adds the second signature |
| Contributors signed in with email and password, and typed in a withdrawal address | The connected Stellar address is the identity, the session subject and the payout destination |
| A new wallet needed XLM before it could hold USDC | Centient sponsors the account reserve and the USDC trustline, and pays every network fee |
| Rewards accrued off-chain and were withdrawn later | Each validated submission becomes an instant on-chain payout, and a reconciler matches every payout to the ledger |

## The four deliverables

| | Deliverable | Week | Status |
| --- | --- | --- | --- |
| [D1](deliverables/d1.md) | **Instant USDC reward rail.** Multisig payout account, independent co-signer, daily cap at both signers, hot/cold reserve | 1 | ✅ Complete. QA passed 28/28 at [`263be4c`](https://github.com/artisam-centient/centient/commit/263be4cd5ab06103d965044c6a8bd3c40678f308) |
| [D2](deliverables/d2.md) | **Wallet-native onboarding.** Freighter sign-in by signed challenge, plus sponsored account and trustline for zero-XLM wallets | 2 | ✅ Complete. QA passed at [`8f660cc`](https://github.com/artisam-centient/centient/commit/8f660cc632f1c868a41618434a1c169dc0edabcc), 38 of 40 executed, 2 accepted as residual |
| [D3](deliverables/d3.md) | **End-to-end contributor loop.** Connect, rank, validate, co-sign, pay, reconcile, with no custodial balance | 3 | ✅ Complete. QA passed at [`1fde77d`](https://github.com/artisam-centient/centient/commit/1fde77d539ca040bb12c07df0c82dad5c8cf3a58) |
| [D4](deliverables/d4.md) | **Reconciliation and public release.** Failure tests, 100 payouts across 25 wallets, demo. Testnet only | 4 | Not started |

## How to read this book

**Start with the current week.** Each [weekly report](weekly-reports/week-1.md) opens with a plain-English summary, then gives the changelog, the decisions taken, the evidence added and what carries forward.

**To check one deliverable end to end,** open its page under *Deliverables*. Each page has a traceability table with one row per acceptance item: the item, the change that implements it and the evidence that proves it.

**To verify something yourself,** open the linked page. Commit links go to the public mirror on GitHub, and transaction and account links go to stellar.expert. Neither needs an account. The [evidence index](reference/evidence.md) lists every account and transaction from the sprint in one place.

**For the parts that are not finished,** see [Open risks and follow-ups](reference/risks.md). It lists what is still unresolved and what was accepted as a known limit.

{% hint style="info" %}
**About issue and PR numbers.** Numbers such as #8 or PR #75 appear as plain text throughout. They refer to the private development repository (`webnxt-2030/Centient`) and let the builder trace any line back to its ticket. Everything a reviewer needs is public: commits on the mirror, the live app, and on-chain transactions.
{% endhint %}

{% hint style="warning" %}
**Testnet only.** Every account, key and transaction in this book is on Stellar testnet and holds no real value. Testnet is reset from time to time, so the [evidence index](reference/evidence.md) records full hashes, and the raw evidence files are committed in the repository.
{% endhint %}

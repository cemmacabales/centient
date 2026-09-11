# Centient

Centient is a human-feedback labeling platform that pays contributors in USDC on Stellar the moment their work is validated. Customers fund campaigns of ranking tasks; contributors compare pairs of AI responses and are paid per accepted submission from a multisig payout account that no single key can drain.

The current programme of work is the **Instawards** engagement: four weekly deliverables that move the platform from a custodial, single-key payout path to a wallet-native, instant, multisig-signed one.

> **Known drift:** the code still says `labeler` in ~67 files (`labeler_session`, `lib/labeler-auth.ts`, schema comments). The canonical term is **Contributor**. Prefer it in new code, issues, and docs; rename opportunistically rather than in one sweep.

## Language

### People

**Contributor**:
A person who ranks response pairs and is paid in USDC at the Stellar address they connect.
_Avoid_: labeler, annotator, worker, user

**Customer**:
An organization that funds campaigns and consumes the resulting ranking data.
_Avoid_: client, brand, advertiser, admin

### The work

**Campaign**:
A customer-funded batch of tasks sharing a default reward and response target. It holds its own balance, and a task cannot pay out beyond it.
_Avoid_: project, batch, job

**Task**:
One prompt paired with two candidate AI responses for a contributor to choose between.
_Avoid_: question, item, HIT, unit

**Submission**:
One contributor's ranking of one task — the chosen response plus the stated reason. A contributor may submit against a given task only once.
_Avoid_: vote, answer, label, response

**Ranking**:
The act of producing a submission. The contributor-facing verb for the whole loop's first step.
_Avoid_: labeling, tagging, rating, grading

**Gold Task**:
A task whose correct answer is already known, used to measure a contributor's accuracy rather than to collect data.
_Avoid_: honeypot, control, attention check, trap

**Response Target**:
The number of submissions a task must accumulate before its majority answer is resolved.
_Avoid_: quota, sample size, N

**Agreement Score**:
The proportion of a resolved task's submissions that match its majority answer.
_Avoid_: consensus rate, confidence, IAA

**Quality Guard**:
Any control that decides whether a submission is acceptable — gold-task accuracy, rate limits, spam detection. Keyed to the contributor's Stellar address.
_Avoid_: fraud check, filter, validator

**Validated Submission**:
A submission that has passed the quality guards and is therefore eligible to trigger a payout. Validation is the only thing that authorizes payment.
_Avoid_: approved answer, accepted label, cleared submission

**Task Ledger**:
The durable record of submissions, rewards, and destinations. It is the authority the policy co-signer independently re-derives a payout from, rather than trusting the payout request it is handed.
_Avoid_: submission table, work log, audit trail

### The payout rail

**Reward**:
The USDC amount a task pays for one validated submission.
_Avoid_: fee, bounty, wage, rate

**Payout**:
A single USDC payment settling one validated submission, sent to the contributor's connected address.
_Avoid_: disbursement, transfer, reward payment

**Instant Payout**:
A payout triggered by validation itself, with no balance accrued in between. The end state of the contributor path.
_Avoid_: real-time payment, auto-payout

**Payout Account**:
The always-online Stellar account every payout originates from. A native multisig with a signing threshold of at least two, so no single key can move contributor funds.
_Avoid_: platform wallet, sender account, master account

**Hot Wallet**:
The payout account viewed as a custody tier — the online half of hot/cold separation.
_Avoid_: operational wallet, live wallet

**Float**:
The bounded USDC balance the hot wallet is permitted to hold. It defines the worst-case loss if that wallet is fully compromised.
_Avoid_: working balance, buffer, operating balance

**Cold Reserve**:
The separate 2-of-3 multisig account holding bulk funds. Its signers live on isolated infrastructure and sign only refills.
_Avoid_: treasury, vault, cold storage

**Refill**:
A multisig-approved transfer from the cold reserve that tops the float back up. There is no single-key path out of the reserve.
_Avoid_: top-up, replenishment, funding transfer

**Policy Co-signer**:
The operationally independent service supplying the second signature. It re-derives the expected amount and destination from the task ledger and signs only on a match, so forging a payment requires compromising two isolated systems.

That last clause is a claim about **key custody**, not about code: it holds only while no single deployment holds enough of the payout account's seeds to reach its threshold alone. D1 QA found `web` holding both the master and the ops signer (F-01), which met the 2-of-2 threshold and made the co-signer bypassable while every code-level guard stayed green. `assertCustodyBelowThreshold` (`lib/stellar/key-custody.ts`) now refuses that configuration at the payout boundary.
_Avoid_: signer service, approver, second signer, validator

**Daily Cap**:
The configurable ceiling on total payouts per day, enforced independently at both signers so neither alone can lift it.
_Avoid_: rate limit, spend limit, throttle

**Fee-Bump**:
Centient paying the XLM network fee for a contributor's transaction, so contributors transact without ever holding XLM and receive USDC intact.
_Avoid_: gas sponsorship, fee subsidy

**Base Unit**:
The integer unit all money is held and compared in — one ten-millionth of a USDC. Amounts are never floating point.
_Avoid_: stroops (that is XLM's unit), decimal amount, cents

**Reconciler**:
The process that matches every payout against the submission and ledger amount it settles and against the on-chain transaction, and reports anything it cannot match.
_Avoid_: settlement checker, auditor, sweeper

**Unreconciled Payout**:
A payout the reconciler cannot match to trusted state — a duplicate, a mismatch, or an orphan. The count that must be zero.
_Avoid_: orphan payment, discrepancy, exception

### Wallet-native identity

**Stellar Address**:
The case-sensitive `G…` address that is simultaneously a contributor's identity, session subject, and payout destination. Never normalized or lower-cased.
_Avoid_: wallet ID, account number, public key

**Signed Challenge**:
The one-time, expiring message a contributor signs to prove they control an address. Single-use and bound to that address.
_Avoid_: nonce login, signature login, magic link

**First Connect**:
The one-time flow that binds a newly connected wallet to a contributor identity and establishes it as the payout destination.
_Avoid_: signup, registration, onboarding flow

**Sponsored Account Creation**:
Centient paying the base reserve that brings a brand-new, zero-XLM address into existence on the network.
_Avoid_: account funding, friendbot, provisioning

**Sponsored Trustline**:
A USDC trustline Centient funds on a contributor's behalf so their address can hold USDC.
_Avoid_: token approval, asset opt-in

**Sponsored Reserve**:
XLM that Centient has locked on a contributor's behalf to keep their account and trustline alive. It is a tracked platform liability, capped per contributor.
_Avoid_: locked balance, deposit, collateral

**Reserve Reclaim**:
Releasing a sponsored reserve back to Centient once it is no longer needed.
_Avoid_: refund, unlock, recovery

### The custodial path (being retired)

These terms describe the accumulate-then-withdraw model the platform is moving off. They remain accurate for the system as it stands, and are removed from the active contributor path in Deliverable 3.

**Pending Balance**:
Rewards credited to a contributor off-chain and not yet paid out. The instant payout path never creates one.
_Avoid_: wallet balance, escrow, credits

**Withdrawal**:
A lump-sum transfer of an accumulated pending balance to an address the contributor names.
_Avoid_: cash out, payout (a payout settles one submission; a withdrawal drains a balance)

**Flagged Withdrawal**:
A withdrawal stopped by an anti-fraud gate — banned identity, shared destination, or failed eligibility — and queued for a human decision.
_Avoid_: blocked payment, fraud alert

### Delivery

**Deliverable**:
One of the four scoped weekly outcomes of the Instawards engagement. Each is a contractual unit with its own definition of done and evidence.
_Avoid_: milestone, phase, release

**Epic**:
The issue tracking one deliverable's week of work and the sequence of implementation issues inside it.
_Avoid_: story, initiative, workstream

**QA Gate**:
The final issue of an epic: a human manual QA pass against one frozen build, run after development stops. An epic closes only when its gate records a pass.
_Avoid_: sign-off, acceptance test, UAT

**Dev Cut**:
The point each week when implementation stops and the tested build is frozen for QA.
_Avoid_: code freeze, feature freeze

**Evidence Package**:
The transaction hashes, recordings, and CI results that prove a deliverable was met, assembled against on-chain facts rather than assertions.
_Avoid_: report, proof, deliverable docs

### Superseded vocabulary

The platform's first payout substrate was Celo/MiniPay. Those terms survive in `spec.md` and legacy constants, but describe no live behaviour and should not re-enter new work.
_Avoid_: MiniPay, cUSD, Celo, chain ID, gas, wei, ERC-20

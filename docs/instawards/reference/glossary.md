# Glossary

The words this book uses, and what each one means precisely.

## People

**Contributor.** A person who ranks response pairs and is paid in USDC at the Stellar address they connect. The code still says *labeler* in places; the terms mean the same thing.

**Customer.** An organisation that funds campaigns and consumes the resulting ranking data.

## The work

**Campaign.** A customer-funded batch of tasks sharing a default reward and response target. It holds its own balance, and a task cannot pay out beyond it.

**Task.** One prompt paired with two candidate AI responses for a contributor to choose between.

**Submission.** One contributor's ranking of one task: the chosen response plus the stated reason. A contributor may submit against a given task only once.

**Gold task.** A task whose correct answer is already known, used to measure a contributor's accuracy rather than to collect data.

**Response target.** The number of submissions a task must collect before its majority answer is resolved.

**Agreement score.** The share of a resolved task's submissions that match its majority answer.

**Quality guard.** Any control that decides whether a submission is acceptable: gold-task accuracy, rate limits, spam detection. Keyed to the contributor's Stellar address.

**Validated submission.** A submission that has passed the quality guards and can therefore trigger a payout. Validation is the only thing that authorises payment.

**Task ledger.** The durable record of submissions, rewards and destinations. The policy co-signer re-derives each payout from it instead of trusting the request it receives.

## The payout rail

**Reward.** The USDC amount a task pays for one validated submission.

**Payout.** One USDC payment settling one validated submission, sent to the contributor's connected address.

**Instant payout.** A payout triggered by validation itself, with no balance accrued in between.

**Payout account / hot wallet.** The always-online Stellar account every payout comes from. It is a native multisig with a threshold of at least two, so no single key can move contributor funds.

**Float.** The bounded USDC balance the hot wallet may hold. It is the worst-case loss if the hot wallet is fully compromised.

**Cold reserve.** A separate 2-of-3 multisig account holding bulk funds. Its signers are not held by any deployed service, and it signs only refills.

**Refill.** A multisig-approved transfer from the cold reserve that restores the float to its target. There is no single-key path out of the reserve.

**Policy co-signer.** The operationally independent service that supplies the second signature. It re-derives the expected amount and destination from the task ledger and signs only on a match. Forging a payment therefore requires compromising two isolated systems. That holds only while **no single deployment holds enough signer weight to reach the threshold** (finding F-01).

**Daily cap.** The configurable ceiling on total payouts per day, enforced independently at both signers so that neither can lift it alone.

**Fee bump.** Centient pays the XLM network fee for a transaction, so contributors never need XLM and receive their USDC in full.

**Base unit.** The integer unit all money is held and compared in: one ten-millionth of a USDC. Amounts are never floating point.

**Reconciler.** The process that matches every payout against its submission, its ledger amount and its on-chain transaction, and reports anything it cannot match.

**Unreconciled payout.** A payout the reconciler cannot match to trusted state: a duplicate, a mismatch or an orphan. The count must be zero.

## Wallet-native identity

**Stellar address.** The case-sensitive `G…` address that is at once a contributor's identity, their session subject and their payout destination. Never normalised or lower-cased.

**Signed challenge.** The one-time, expiring message a contributor signs to prove they control an address. It is single-use and bound to that address and network.

**First connect.** The one-time flow that binds a newly connected wallet to a contributor and makes it the payout destination.

**Sponsored account creation.** Centient pays the base reserve that brings a brand-new, zero-XLM address into existence on the network.

**Sponsored trustline.** A USDC trustline Centient funds for a contributor so that their address can hold USDC.

**Sponsored reserve.** XLM Centient has locked for a contributor to keep their account and trustline alive. It is a tracked platform liability, capped per contributor.

**Reserve reclaim.** Releasing a sponsored reserve back to Centient once it is no longer needed and it is safe to do so.

## Process

**Dev cut.** Wednesday, end of day. After it, the week's build is frozen for QA.

**Build under test.** The exact SHA the QA gate evaluates. Any later merge moves it.

**`QA PASSED <sha>`.** The approval of record on an epic's gate issue, naming the SHA the pass covers.

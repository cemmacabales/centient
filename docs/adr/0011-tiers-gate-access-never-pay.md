# ADR-0011: Tiers gate which tasks are open, never what they pay; a missed floor holds, never demotes

- **Status:** Accepted — 2026-10-12
- **Scope:** Tiers, holds, crowd match and stamps (epic [#200](https://github.com/webnxt-2030/Centient/issues/200), issue 2 of 3).
- **Relates to:** [#202](https://github.com/webnxt-2030/Centient/issues/202) (this change), [#203](https://github.com/webnxt-2030/Centient/issues/203) (weekly board, event codes), [ADR-0010](0010-xp-is-never-money.md) (XP is never money, written beside the rail), [ADR-0005](0005-submit-enqueues-worker-pays.md) (submit enqueues, the worker pays).

## Context

ADR-0010 settled that money moves only through tasks: harder tasks pay more,
and XP never converts to USDC. #202 decides who is served those harder tasks.
The pool was priced by difficulty on 9 Oct (1–9), so a tier is a difficulty
band, and the question is how a labeler earns a band and what happens when
their quality slips.

Three facts from production on 12 Oct shaped the rules:

- No live task has a `responseTarget`, so no task had ever resolved and crowd
  match had no data at all.
- No labeler had 10 quality checks yet; the median labeler had 2 answers.
- XP started accruing only at #201's deploy, so at merge every labeler is
  Starter and would lose the 4–9 band (190 of 248 tasks) the moment gating ran.

## Decision

**A tier opens a band and pays nothing.** Starter serves difficulty 1–3,
Skilled 4–5, Trusted 6–7, Expert 8–9. A task with no difficulty is open to
every tier, so platform quality checks (which carry none) look like any other
task. `Campaign.minTier` (Everyone, Skilled and up, Trusted and up) narrows a
campaign's crowd; Expert-only campaigns come later. Reward amounts, the payout
rail, the co-signer and the multisig are untouched.

**Entry needs XP and quality.** 250 / 1,500 / 4,000 XP; quality checks at
80% / 85% / 90% of the last 10; crowd match at 70% / 75% of the last 50
resolved answers for Trusted and Expert; 20 active Manila days for Expert. A
floor applies only once there is enough history to judge it: 5 checks, 20
resolved answers. Below that, XP alone decides. Every threshold lives in
`lib/gamification/tiers.ts`, so a retune after the first week is one change.

**A missed floor holds the tier; it is never taken away.** A failed check that
leaves the window under the floor, or a crowd miss that does, puts the tier on
hold: its band pauses and the labeler is served the band below, keeping their
XP and tier name. The next 3 checks passed in a row reopen it. A hold starts
only on the event that lowered the signal, so a tier that has just reopened
isn't held again by the next answer. XP keeps accruing on hold, but the next
tier can't open until the hold lifts.

**A tier opens only on an answer or a passed check.** Those are the moments the
labeler is looking, so the tier-up screen always shows. Crowd results and
payouts settle in the worker and can hold a tier or award a stamp, but never
open one; the next answer does, with the XP they added.

**Resolution gets a threshold of its own.** A task with no target of its own or
its campaign's resolves at `RESOLUTION_MIN_ANSWERS` settled answers (default
5). That writes `majorityAnswer`, `agreementScore` and `resolvedAt` only;
supply stays uncapped, which a response target alone does. The write is
conditional on `resolvedAt` being null, so two workers resolve a task once.
This resolution is best effort, beside the rail: if it fails, the paid answer's
job still reaches `done`, and the task's next payout tries again. If that was
the task's last payout, it stays open and its crowd XP is never awarded: XP
lost, never money. A task with
its own `responseTarget` resolves on the rail, as it did before.

**Crowd match is +5 XP, beside the rail.** When a task resolves, each settled
answer matching the majority earns `CROWD_MATCH` XP, keyed
`crowd:<submissionId>`; an answer that settles on an already-resolved task is
judged alone. A tie (`agreementScore` 0.5) earns nothing: its recorded "A" is
only the tie-break. Like ADR-0010's XP, this runs in the payout worker after
the job is marked `done`, best effort: a failure is reported to Sentry and
never holds or quarantines the payout.

**Retest stays out.** Gold checks answered during post-cooldown retest are
marked `Submission.retest` and left out of the floors and stamps; retest
decides a ban, not a tier. Retest rows written before the column existed are
marked by a backfill: the first 3 checks after a labeler's latest ban
(`users.lastBanAt`), since nothing else is accepted while banned. Earlier bans
aren't on record.

**A quality check looks like any task.** A gold task has no difficulty, which
would always read as 10 XP and Starter on the task screen. It shows a stand-in
difficulty instead: a real open task's, picked stably per labeler and task from
the band that labeler is served, so checks follow the pool's own spread. Display
only: a passed check still earns `QUALITY_CHECK` XP, and its reward amount is
unchanged (gold has always paid the default, a separate tell).

## Consequences

- Gating runs only with the server flag `GAMIFICATION_GATING=on`, turned on
  with `NEXT_PUBLIC_GAMIFICATION` in production. With it off, serving is as
  before. Any XP backfill (`npm run xp:repair -- --since=<date> --apply`)
  should run before gating goes on, so returning labelers don't restart at
  Starter.
- Submit applies the same rule as serving: with gating on, an answer to a task
  outside the labeler's band, or in a campaign above their tier, is refused
  `tier_locked` before any write. Serving alone would let a posted task id
  reach a harder, better-paid task.
- More answers on pricier tasks fill the daily payout cap sooner and drain
  campaign balances faster. Watch both in the first week.
- Exports gain `labeler_tier`, the tier when the answer was given
  (`Submission.labelerTier`), so a customer's export doesn't shift as
  labelers level up. Rows from before #202 read empty for the tier.
- `tier_up`, `tier_on_hold` and `stamp_awarded` are sent from the server, keyed
  by the internal user id the browser identifies with, at the one transaction
  that changes them. Each fires once, wherever it happened.
- Health specialist asks for 25 health answers, not the boards' 40: today's
  pool has 31 health tasks and each is answered once. Retune it with the
  others as campaigns add tasks.
- XP backfill is approved: `xp:repair` over all history runs on staging once
  the epic's promotion deploys, and on production before gating goes on.

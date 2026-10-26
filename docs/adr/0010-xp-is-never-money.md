# ADR-0010: XP is never money, and it is written beside the payout rail

- **Status:** Accepted — 2026-10-12
- **Scope:** The gamification loop (epic [#200](https://github.com/webnxt-2030/Centient/issues/200)): XP, the daily goal, streaks and rest days, and the submit path that awards them.
- **Relates to:** [#201](https://github.com/webnxt-2030/Centient/issues/201) (this change), [#202](https://github.com/webnxt-2030/Centient/issues/202) (tiers), [#203](https://github.com/webnxt-2030/Centient/issues/203) (weekly board), [ADR-0004](0004-wallet-native-quality-guards.md) (rejected answers create no payout intent), [ADR-0005](0005-submit-enqueues-worker-pays.md) (submit enqueues, the worker pays).

## Context

#201 adds a loop to bring labelers back each day: XP for accepted answers, a
daily goal of 5 answers, a streak of days the goal was met, and rest days that
cover a missed day. Its rewards had to be decided against two constraints the
payout rail already sets:

- Every accepted answer is its own USDC payment. The submit route writes the
  campaign debit, the `pending` row and its `SUBMISSION_PAYOUT` job in one
  transaction, and the co-signer and the worker re-read that row before they
  sign (#37, ADR-0005).
- A rejected answer creates no payout intent (ADR-0004), and the quality guards
  depend on that holding for every rejection path.

The owner decided on 2026-10-12 that money moves only through tasks: harder
tasks, opened by tier in #202, pay more. There is no USDC bonus.

## Decision

**XP never converts to USDC.** There is no exchange rate, no bonus payout and no
new payment path. XP lives in its own ledger (`XpEvent`) and its own counters on
`User`. Nothing in the payout worker, the co-signer or the reconciler reads it.

**Only what is accepted earns XP.**

| Answer | XP | Counts toward the daily goal |
| --- | --- | --- |
| Accepted | 10 / 15 / 20 by `Task.difficulty` (1–3, 4–6, 7–9; unknown pays 10) | yes |
| Passed quality check, outside retest | 5 | yes. Labelers can't tell a check from a task before answering, so a goal that skipped checks would look broken. |
| Any rejection (spam, repetition, rate limit, bans, duplicate, target reached, failed check, bias, unfunded campaign, no trustline) | none | no |
| Any answer during post-cooldown retest | none | no. The account is under review. |

The goal pays 20 XP once a day, and streak milestones at 3, 7, 14 and 30 days
pay 25, 50, 100 and 200. Every 7 streak days earn a rest day, at most 2 held.
Days and weeks are Asia/Manila calendar days. A day on which `/api/task` had
nothing open for the labeler is protected: it can't break a streak.

**The XP write sits after the payout transaction, not inside it.** The submit
route calls `recordAccepted` only once the answer's own transaction has
committed, in a transaction of its own. A failure there is reported to Sentry
(`submit-xp`) and the answer still succeeds, without a `progress` block. An XP
bug or a lock on the XP tables can therefore never roll back an accepted answer
or its payout job, and the rail's failure surface is exactly what it was.

**Every award is idempotent.** Each `XpEvent` carries a unique `dedupeKey`
(`answer:<submissionId>`, `check:<submissionId>`, `goal:<userId>:<day>`,
`streak:<userId>:<day>`), so recording an answer twice awards it once. The
ledger is append-only, like `BalanceLedger`.

## Consequences

- Because the write is not atomic with the answer, an accepted answer can end
  up without its XP. `npm run xp:repair -- --since=<ISO date>` lists those
  answers, and `--apply` writes each missing `ANSWER` event once. It restores
  the XP only. Re-settling a past day would rewrite a streak the labeler has
  already seen, so the day's goal and the streak stay as they were.
- XP stays earned if the answer's payout later fails and is refunded. The
  answer was accepted; the payment failing is the rail's problem, not the
  labeler's quality.
- `app/api/submit/__tests__/payout-intent-db.test.ts` asserts that every rejected
  path writes no `XpEvent` and no `DailyProgress`, beside the payout-intent
  assertions it already made.
- `Task.difficulty` is filled from the 9 Oct pool pricing
  (`prisma/data/task-difficulty-2026-10-09.json`) by the seed's upserts on
  every deploy. They change only that column; prices set on 9 Oct stay.
- The UI shows only with `NEXT_PUBLIC_GAMIFICATION=on`. Server writes run from
  merge, so XP accrues before labelers see it. The flag stays off in production
  until #202 lands and on in staging for QA.

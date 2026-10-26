# ADR-0012: The weekly board ranks careful labor and shows no money; event codes give a stamp, never a place

- **Status:** Accepted — 2026-10-12
- **Scope:** The weekly board, display names, event codes, weekly quests and invites (epic [#200](https://github.com/webnxt-2030/Centient/issues/200), issue 3 of 3).
- **Relates to:** [#203](https://github.com/webnxt-2030/Centient/issues/203) (this change), [ADR-0010](0010-xp-is-never-money.md) (XP is never money), [ADR-0011](0011-tiers-gate-access-never-pay.md) (tiers, floors from enough history).

## Context

#203 adds the social layer: a weekly board, names on it, and codes handed out
at booths and webinars. The first contributor webinar is Thursday 15 Oct, so
codes have to work on staging that day. Three things needed deciding: what the
board may show, what it ranks, and how a code can and can't be used.

Two facts shaped the rules:

- Gold checks are about 10% of serves, so most labelers see 0–2 quality checks
  in a week. A strict weekly 80% floor would judge them on one answer.
- Nothing in the app runs on a schedule. Cron routes exist, but whoever
  schedules them sits outside the repo.

## Decision

**The board shows no money and no identity.** A row is a rank, a name or null
("Hidden labeler"), a tier and XP. No wallet, no earnings, no user id reaches
the browser; the route test asserts on the raw body. Names are opt-in:
nothing shows until the labeler sets a name and turns "Show my name" on.

**Names are unique, filtered and retired when hidden.** 3–20 characters,
`[a-z0-9._]`, starting with a letter, stored lowercase so uniqueness ignores
case. An in-repo blocklist (English and Filipino profanity and slurs, and
reserved words such as admin, centient and hidden labeler) catches long words
anywhere, through dots, underscores and digit swaps, and short ones only as a
whole word, so "batangas" and "peacock" pass. No dependency. An admin hide
retires the name for everyone (`retired_display_names`), clears it, and asks
its owner for another; the hide is audit-logged as `displayName.hide`.

**The board ranks labor, Monday to Sunday in Manila.** XP from the ledger for
the week's `weekKey`, every kind except `EVENT_CODE` and `INVITE`, so a booth
code or a referral can't buy a place (both still count toward tiers). Ties go to whoever reached the total
first. To place, quality checks that week must be 80% or better, counted from
3 checks; under 3, XP alone places, as ADR-0011's floors do. Checks are counted
by time within the Manila week, since a failed check writes no XP row. A
labeler banned when the week is read or closed doesn't place, even for a week
they earned before the ban. The top 20 show, with the caller's own row below them when they're further down.

**A week closes lazily, once.** The first board read of a new week records each
placed labeler's finish (`weekly_results`, for "Best: #6") and awards the Top 3
stamp to those who don't hold it. It closes every finished week since the
newest closed one, so a week nobody read the board after still closes; before
any week has closed, only last week is, so weeks of backfilled XP from before
the board stay open. One board read closes at most 4 weeks, oldest first, and
the next read goes on; `POST /api/cron/weekly-board` closes up to a year as a
backstop. The week's `board_weeks` row is inserted in the same
transaction, `ON CONFLICT DO NOTHING`, so racing reads close it once. A week
still running is never closed.

**An event code gives its own stamp and 25 XP, once per account, on its days.**
Each code carries a stamp title and an icon from an allow-list, and awards
`event:<codeId>`; the fixed Event slot stays open for the next event, so the
stamp count grows with each one. A code needs a bound Stellar wallet (the
`/api/task` gate), is refused while banned, matches case-insensitively, and is
open on its Manila days `startsDay..endsDay` inclusive. Every attempt counts
toward 10 an hour per labeler, so a code can't be found by trying. The
redemption row's key (code, account) refuses a second one; the stamp and the
`EVENT_CODE` XP row (`event:<codeId>:<userId>`) carry their own unique keys as
a second guard. Creating a code is audit-logged as `eventCode.create`.

**A booth link never redeems on its own.** `?code=` is kept in the tab's
sessionStorage through sign-in and onboarding, stripped from the address bar,
and opens Progress with the code on the Event code card. The labeler taps Add.
The card doesn't name the stamp before redeeming: that would need a lookup
outside the guess limit.

### Quests and invites

**Three fixed quests a week, 30 XP each.** Answer 5 health tasks, pass 3
quality checks, meet the daily goal on 4 days; the same every Manila week in
v1. A quest is awarded on the answer or passed check that completes it, after
that answer's XP commits and before its tier is weighed, so quest XP can open a
tier. Never in the payout worker. The `QUEST` XP row is keyed
`quest:<questId>:<userId>:<weekKey>`, so racing answers pay it once. Quests are
labor, so their XP counts on the board.

**An invite is captured only when an account is created.** Each labeler has an
8-character code (no look-alike characters) and a link `/?invite=<code>`. The
link sets a 7-day `centient_invite` cookie; the wallet sign-in route reads it,
records `invitedById` only on the sign-in that creates the account, and clears
it. An existing account, a self-invite or a bad code is ignored, and sign-in
goes on.

**An invite pays once, when the friend first reaches Skilled.** Then both get
50 `INVITE` XP (`invite:<inviteeId>:invitee|inviter`) and a stamp: "Invited in"
and "Brought a friend", so the fixed stamps are 14. `invite_rewards` is keyed
by the invitee, so it pays once. The inviter is paid for at most 10 friends;
their row is held while the count is read, so two friends qualifying together
can't pass the cap. Past the cap, or when the inviter is banned, the friend is
still paid and the inviter isn't. Invite XP counts toward tiers but not on the
board.

## Consequences

- The labeler UI ships behind `NEXT_PUBLIC_GAMIFICATION`. The admin
  Gamification tab doesn't, so codes can be created on staging before the flag
  turns on. Server writes run from merge.
- The XP backfill should run before the flag turns on: the first board read
  closes last week, and a week closed on partial XP stays closed.
- `event_code_redeemed`, `display_name_set`, `quest_completed`,
  `invite_qualified` and `stamp_awarded` (Top 3, event and invite stamps) are
  sent from the server; `board_viewed` from the browser.
- No late window for BlockQuest Fiesta (10–12 Oct): codes are valid only
  inside their dates. An admin can record a past event's code; it can't be
  redeemed.
- Watch the board for name abuse and the guess rate on codes in the first
  week.

# ADR-0004: Key the quality guards to the proven wallet; retire shared-wallet as a submit guard

- **Status:** Accepted — 2026-09-21
- **Scope:** Deliverable 3 (instant wallet-native payout) and the submit path it pays from.
- **Relates to:** [#36](https://github.com/webnxt-2030/Centient/issues/36) (E3-2 quality guards), [#37](https://github.com/webnxt-2030/Centient/issues/37) (instant payout), [#39](https://github.com/webnxt-2030/Centient/issues/39) (retire accumulate-then-withdraw), [#41](https://github.com/webnxt-2030/Centient/issues/41) (Epic 3 QA gate).

## Context

Since #30, an account can answer only while it holds a bound Stellar `G…`
address. `/api/me/wallet` binds an address once, and `User.walletAddress` is
unique, so a bound address never moves between accounts. For every account
that can submit, the `userId` and the address identify the same contributor.

Before #36, two identity guards ran only at withdrawal: the banned-identity
check (`isAnyIdentifierBanned`) and the shared-wallet check
(`checkSharedWallet`). #37 pays at submit, and #39 removes the withdrawal step,
so withdrawal-time checks would have stopped protecting anything.

## Decision

**Each guard's identity:**

| Guard | Keyed on | Where |
| --- | --- | --- |
| Reason spam, reason repetition | `userId` (= address) | submit |
| Rate limit, one per 15 s | `userId` (= address). It stays on the session's id so it runs before the user read it protects. | submit |
| Account ban, cooldown, retest | `User` row | submit |
| Banned identity (EMAIL, WALLET, USER_ID, plus identifier history) | the proven address and the account's other identifiers | submit, before any write; wallet sign-in; withdrawal (until #39) |
| Gold scoring, ban rule | `userId` (= address) | submit |
| Left/right bias | `userId` (= address) | submit |
| Shared wallet | accounts that withdrew to an address | withdrawal only |

**Shared wallet is not a submit guard.** It counts the accounts that have
*withdrawn to* an address. With one permanent address per account, and no
withdrawals once #39 lands, that count cannot exceed one, so the check has
nothing left to measure. It stays at withdrawal until #39 retires that route.

**Rejected submissions create no payout intent.** No campaign debit, no labeler
credit, no `PayoutJob`, and any `Submission` written reads as `skipped` with no
amount. The campaign debit and the rewarded row commit in one transaction, so
neither exists without the other. `app/api/submit/__tests__/payout-intent-db.test.ts`
proves this for every rejection path. #37 builds instant payout on top of it.

**Rejection logs carry codes and IDs only.** They do not carry the working
values that show how close an account is to a threshold (bias counts, gold
accuracy), the reason text, or the value of a matched banned identifier.

## Consequences

- **Accepted residual for #41:** sybil resistance beyond the unique address rests
  on `BannedIdentity`, gold scoring and bias detection. One person holding many
  funded addresses, each with its own account, is not detected by address
  bookkeeping. Detecting that needs signals this project does not collect
  (funding-source graph, device, behaviour), so it is out of scope for Epic 3.
- The flagged-withdrawal admin ban sets `isBanned` with no `bannedUntil`, which
  the cooldown predicates don't read as a ban. The `BannedIdentity` rows written
  with it are what now stop that account at submit and at sign-in.
- A banned contributor's wallet sign-in returns 403 `banned`. The sign-in client
  shows its generic failure message for that code. No UI change was made in #36.

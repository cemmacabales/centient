# Payout API (D4, #48)

Every public HTTP route of the contributor app and the payout rail. For each
route: method, auth, request, response, error codes, and effect on payout state.
Written from `app/api/**/route.ts` at the commit that adds this file. The route
handlers are the source of truth, so if the two disagree, trust the code.

**Stellar testnet only** (D-7). The public build is `https://beta.centient.work`.
`GET /api/version` names the commit it runs and the network.

## Conventions

- **JSON in, JSON out.** A refusal is `{ "error": "<code>" }` with the status
  shown, sometimes with a `message` or extra fields. Codes are stable strings
  and statuses follow them. Branch on the code, not on the text.
- **Amounts.** `…Units` fields are 7-decimal Stellar base units as decimal
  strings (1 USDC = `10000000`). `…Display` and `payoutAmount` fields are
  formatted USDC for display.
- **Addresses** are Stellar `G…` StrKeys and are case-sensitive. The API never
  normalizes them, so a lowercased key is refused as `invalid_address`.
- **Rate limits** answer `429 { "error": "rate_limited" }`. The sponsor route
  also sends `Retry-After`.

## Authentication

| Kind | How | Used by |
| --- | --- | --- |
| **Public** | None | Sign-in, `health/wallet`, `version`, `verify-email` |
| **Contributor session** | The `labeler_session` cookie: an HS256 JWT holding the account id. It is `httpOnly`, `SameSite=Lax`, `Secure` in production, and lasts 7 days. Issued by wallet sign-in (`/api/auth/wallet/verify`) or email login (`/api/auth/login`) | `task`, `submit`, `submissions/[id]`, `me/*` |
| **Cron bearer** | `Authorization: Bearer <CRON_SECRET>`. If the variable is unset, every cron call is refused | `/api/cron/*` |
| **Admin session** | The `admin_session` cookie, checked by `middleware.ts` for all of `/api/admin/**` except login and logout | Admin routes (listed at the end) |

A session belongs to an **account** (`User.id`). Since #30 the account's bound
Stellar wallet is both its identity and its only payout destination. No route
takes a payout address from the request body.

## Payout state

An accepted answer creates a submission with a `payoutStatus`, plus one
`SUBMISSION_PAYOUT` job. The worker, the retry cron and the reconciler move it
forward. No request does.

| `payoutStatus` | Meaning |
| --- | --- |
| `pending` | Accepted and owed. Queued, not broadcast |
| `sent` | Horizon accepted the envelope and its hash is stored |
| `confirmed` | The reconciler saw it applied, paying exactly what was owed |
| `failed` | An attempt failed. The retry cron takes it again after backoff |
| `abandoned` | Retry budget (5) spent. Revival can still hand it back if its envelope is later proven |
| `needs_reconciliation` | Held for a human: a payment that could not be recorded, or one that differs from what was owed |
| `skipped` | Recorded with no payout: a gold check, a failed quality check, left bias, or an unfunded campaign |
| `accrued` | Legacy: credited to the off-chain balance before #39. Withdrawn through `/api/me/withdraw` |

For how these states move, see
[payout reconciliation](payout-reconciliation.md) and the
[failure matrix](payout-failure-matrix.md).

---

## Sign-in

### `POST /api/auth/wallet/challenge`

Issue a one-time sign-in challenge for a wallet (#25).

- **Auth:** public.
- **Request:** `{ "address": "G…" }`
- **200:** `{ "nonce", "message", "expiresAt" }`. Sign `message` with Freighter's
  `signMessage` (SEP-53) and send the result to `/verify` within 5 minutes.
- **Errors:** `400 invalid_address`, `429 rate_limited` (20/min per IP, 5/min per
  address).
- **Payout state:** none. It writes a challenge row.

### `POST /api/auth/wallet/verify`

Sign in by proving control of the address. This creates a wallet-only account
the first time it sees an address.

- **Auth:** public.
- **Request:** `{ "address", "nonce", "signature", "signerAddress"? }`.
  `signature` is base64, and `signerAddress` is the signer Freighter reported.
- **200:** `{ "success": true, "userId", "walletAddress", "created" }`, and sets
  `labeler_session`.
- **Errors:**
  - `400 invalid_body` or `invalid_address`. The challenge is untouched.
  - `401` with one of `challenge_not_found`, `challenge_expired`,
    `wrong_address`, `wrong_network`, `wrong_signer` or `bad_signature`. A
    refused proof leaves the challenge in place, so a stranger cannot burn it.
  - `403 banned`: the email, address or account is banned (#36).
- **Payout state:** none. The proven address becomes the account's payout
  destination.

### `POST /api/auth/login`

Email and password login, for accounts created before wallet sign-in.

- **Auth:** public.
- **Request:** `{ "email", "password" }`
- **200:** `{ "success": true, "userId" }`, and sets `labeler_session`.
- **Errors:** `400 invalid_body`, `401 invalid_credentials` (the same for an
  unknown email and a wrong password), `403 email_not_verified`, and
  `429 rate_limited` after 5 failures per IP in 10 minutes.
- **Payout state:** none. Such an account must bind a wallet
  (`/api/me/wallet`) before it can earn.

### `POST /api/auth/register`

Retired (#30). Always `410 { "error": "email_registration_retired" }`.

### `POST /api/auth/logout`

Clears `labeler_session` and redirects `303` to `/`.

### `GET /api/auth/me`

- **Auth:** optional session.
- **200:** `{ "authenticated": false }`, or `{ "authenticated": true, "userId",
  "wallet", "email", "isVerified" }`. `isVerified` is email confirmation only and
  is always `false` for a wallet-only account.

### `POST /api/verify-email`

- **Auth:** public, keyed by the emailed token.
- **Request:** `{ "token" }`
- **200:** `{ "success": true, "message" }`.
- **Errors:** `400 invalid_body`, `missing_token` or `invalid_token` (unknown or
  expired).

---

## Work and payout

### `GET /api/task`

Serve the next task for the session's account.

- **Auth:** contributor session.
- **200:** `{ "task": { "id", "prompt", "responseA", "responseB",
  "submissionsRemaining", "rewardUnits", "rewardDisplay", "rewardSymbol" } }`.
  With no work left it answers `{ "task": null, "message" }`. During a ban
  cooldown it answers `{ "cooldown": true, "unbannedAt" }`.
- **Errors:** `401 unauthorized`, `409 wallet_required` (no bound Stellar
  wallet).
- **Payout state:** none. A task is a gold check at `GOLD_TASK_RATIO` (always
  during a retest). Nothing in the response says which.

### `POST /api/submit`

Record one answer. If it is accepted, create its payout intent (#37, ADR-0005).

- **Auth:** contributor session.
- **Request:** `{ "taskId", "choice": "A" | "B", "reason" }`
- **200, accepted:** `{ "status": "pending", "submissionId" }`. **Pending is not
  paid.** Poll `/api/submissions/[id]`.
- **200, not paid:** `{ "paid": false, "reason": "quality_check_passed" |
  "quality_check_failed" }`, sometimes with `submissionId`. This is a gold check.
  It earns nothing either way.
- **Errors**, all before anything payable is written:

  | Status | Code | Why |
  | --- | --- | --- |
  | 400 | `invalid_body`, `invalid_task`, `invalid_choice`, `invalid_reason` | Malformed. `invalid_task` also covers a regular task sent during a retest |
  | 400 | `repetitive_reason` | Same reason repeated inside the window |
  | 400 | `left_bias_detected` | Over 95% one side across the last 20. The answer is recorded `skipped` |
  | 401 | `unauthorized` | No session |
  | 402 | `campaign_balance_insufficient` | The campaign cannot fund reward plus fee. The answer is recorded `skipped` with no amount |
  | 403 | `banned` | Identity ban, permanent ban or cooldown |
  | 404 | `task_not_found` | |
  | 409 | `wallet_required` | No bound Stellar wallet |
  | 409 | `already_submitted` | This task was already answered, including a concurrent duplicate (#38) |
  | 409 | `response_target_reached` | The task has all the answers it pays for |
  | 409 | `payout_setup_required` | The wallet has no USDC trustline. Run payout setup (`/api/me/wallet/sponsor`), then answer. Nothing is written |
  | 429 | `rate_limited` | One answer per 15 s per account |
  | 500 | `server_error` | |
  | 503 | `payout_check_unavailable` | Horizon could not say whether the wallet trusts USDC. Nothing is written, so retry |

- **Payout state:** on acceptance, one transaction writes the submission
  `pending` with its reward, the campaign debit (reward plus platform fee, when
  the task has a campaign) and one `SUBMISSION_PAYOUT` job. All three exist or
  none do. The worker then pays through the 2-of-3 multisig and the co-signer.

### `GET /api/submissions/[id]`

One of the session's own submissions and its payout.

- **Auth:** contributor session. The row is matched on the account, so someone
  else's id answers 404, exactly like a missing one.
- **200:** `{ "id", "payoutStatus", "payoutTxHash", "payoutAmount",
  "payoutSymbol", "walletAddress", "taskId", "createdAt" }`.
- **Errors:** `400 invalid_id`, `401 unauthorized`, `404 not_found`.
- **Payout state:** read-only.

---

## Account (`/api/me/*`)

All routes here need the contributor session, and answer
`401 { "error": "unauthorized" }` without it.

### `GET /api/me`

Profile: `{ "walletAddress", "totalEarned", "rewardSymbol", "submissionCount",
"onboardingCompleted", "isBanned", "isCooldown", "isPermanentlyBanned",
"unbannedAt", "banCount", "country", "gender", "ageRange", "bannedReason" }`.
Read-only.

### `GET /api/me/submissions?page=N`

The account's submissions, newest first, 20 per page:
`{ "submissions": [{ "id", "taskId", "taskPrompt", "choice", "isGoldCheck",
"goldPassed", "earnedDisplay", "payoutStatus", "payoutTxHash", "submittedAt" }],
"total", "page", "pageSize", "totalPages" }`. An account with no wallet gets an
empty list. Read-only.

### `POST /api/me/onboarding`

- **Request:** `{ "country", "ageRange", "gender"? }`. `ageRange` is one of
  `18-24`, `25-34`, `35-44`, `45-54`, `55+`. `gender` is `male`, `female` or
  `prefer_not_to_say`.
- **200:** `{ "success": true }`.
- **Errors:** `400 invalid_body`, `missing_required_fields`, `invalid_country`,
  `invalid_age_range` or `invalid_gender`, and `409 onboarding_already_completed`.
- **Payout state:** none.

### `DELETE /api/me/demographics`

Clears country, gender and age range. `200 { "success": true }`. No payout effect.

### `POST /api/me/disputes`

- **Request:** `{ "reason" }`, 10 to 2000 characters.
- **201:** `{ "id", "status", "createdAt" }`.
- **Errors:** `400 wallet_required`, `invalid_body`, `reason_too_short` or
  `reason_too_long`, and `409 open_dispute_exists`.
- **Payout state:** none. An admin resolves disputes.

### `GET /api/me/wallet?address=G…` and `POST /api/me/wallet`

Bind a proven wallet to an account made by email (#30).

- **GET** issues a 5-minute challenge: `{ "message", "nonce" }`.
  - Errors: `400 invalid_address`, and `429 rate_limited` (5/min per address).
- **POST** takes `{ "stellarAddress", "signature" }` (a SEP-53 signature over that
  message).
  - `200 { "linked": true, "walletAddress" }`. Proving the same address again
    also succeeds.
  - Errors: `400 invalid_body`, `invalid_address` or `challenge_expired`, and
    `401 invalid_signature`.
  - `409 address_already_linked`: another account holds that wallet.
  - `409 wallet_already_bound`: this account already holds a different one. A
    wallet is never swapped.
- **Payout state:** sets the account's payout destination, once. There is no
  USDC-trustline check here. That is payout setup, the next step.

### `GET /api/me/wallet/sponsor` and `POST /api/me/wallet/sponsor`

Payout setup: a platform-sponsored USDC trustline (CAP-33), so the contributor
pays 0 XLM (#27). Always for the session's bound wallet. A client may name the
address (`?address=` or `address`), but it must be that wallet exactly.

- **GET:**
  - `200 { "needed": false, "address" }` when the wallet already trusts USDC.
  - Otherwise `200 { "needed": true, "address", "xdr", "kind" }`: a
    platform-signed envelope, with `createAccount` if the address is unfunded,
    for the wallet to co-sign.
- **POST** takes `{ "signedXdr", "address"? }`:
  - `200 { "established": true }`: the account and trustline are in place.
  - `202 { "established": false, "pending": true }`: the outcome is unknown.
    Do **not** rebuild. Poll GET until it says `needed: false`.
- **Errors:**

  | Status | Code | Why |
  | --- | --- | --- |
  | 400 | `invalid_body`, `invalid_sponsor_tx` | Malformed, or not the shape the platform built |
  | 403 | `address_not_bound` | The named address is not the bound wallet |
  | 409 | `wallet_required` | No bound Stellar wallet |
  | 409 | `address_in_use` | Another account's sponsorship holds this address |
  | 409 | `submission_pending` | An earlier envelope may still land |
  | 409 | `retry` | The envelope provably cannot land (`tx_bad_seq`). GET again and re-sign |
  | 429 | `rate_limited`, `sponsorship_cap_reached` | Throttled, or too many outstanding sponsorships (`SPONSOR_MAX_OUTSTANDING`, default 2) |
  | 502 | `build_failed`, `submit_failed` | |
  | 503 | `sponsorship_unavailable` | The sponsor account is short of XLM reserve |

- **Payout state:** none directly. A wallet without a trustline cannot be paid, so
  `/api/submit` answers `payout_setup_required` until this succeeds.

### `GET /api/me/withdraw` and `POST /api/me/withdraw`

**Legacy only** (#39, ADR-0007). Answers have been paid on-chain as they are
accepted since #37. This route only drains balances credited before that.

- **GET:** `{ "pendingBalanceUnits", "destinationAddress", "canWithdraw",
  "withdrawals": [{ "id", "amountUnits", "status", "txHash", "createdAt",
  "completedAt", "error" }] }`. `canWithdraw` mirrors POST's cheap gates. It
  skips the Horizon trustline check.
- **POST:** the body is optional. A `destinationAddress`, if sent, must equal the
  bound wallet.
  - `200 { "status": "queued", "withdrawalId", "amountUnits",
    "destinationAddress", "token" }`.
- **Errors:**

  | Status | Code |
  | --- | --- |
  | 403 | `account_frozen`, `address_not_bound` |
  | 403 | `identity_banned`, `shared_wallet_detected`, `not_eligible` (recorded in the admin flagged-withdrawal queue) |
  | 409 | `wallet_required`, `payout_setup_required`, `no_balance`, `withdrawal_in_flight` |
  | 500 | `server_error` |
  | 502 | `trustline_check_failed` |

- **Payout state:** moves the whole balance into one `WITHDRAWAL` job (at most
  one in flight). The worker pays it through the same multisig. A non-retryable
  failure refunds the balance.

---

## Health and build

### `GET /api/health/wallet`

- **Auth:** public.
- **200:** the payout account's `address`, `usdcBalance`, `xlmBalance`, reserve
  accounting (`availableXlmBalance`, `baseReserveXlm`, `minimumBalanceXlm`,
  `numSubentries`, `numSponsoring`, `numSponsored`, `sponsoredReserveXlm`),
  `sponsorshipLiability` and `sponsorshipReserveDriftUnits` (#27),
  `monitoringStatus`, `assetStatus`, `healthy`, `warnings` and `pages`. An
  unreadable count is `null`, never `0`.
- **Payout state:** read-only.

### `GET /api/version`

- **Auth:** public. `Cache-Control: no-store`.
- **200:** `{ "sha", "shortSha", "commitUrl", "network" }`. `sha` is `null` when
  the build carried no deployment SHA. It is never guessed.

---

## Scheduler (`/api/cron/*`)

All are `POST` with `Authorization: Bearer <CRON_SECRET>`. A missing or wrong
bearer, or an unset `CRON_SECRET`, answers `401 { "error": "Unauthorized" }`.
A crash answers `500 { "error": "…" }`.

### `POST /api/cron/payout-retry`

- **200:** `{ "message": "Cron cycle complete", "retried", "errored",
  "abandoned" }`.
- **Payout state:** the one cron that moves money. It retries up to 100
  submissions with no live job:
  - `pending` rows older than 5 minutes;
  - `failed` rows past `min(2^retryCount × 60 s, 8 min)`.

  Each retry settles the row's open attempt first, so an envelope that may still
  land is never rebuilt. A non-retryable rail error spends the whole budget. It
  ends by marking `pending`/`failed` rows with `retryCount >= 5` as `abandoned`.
  The co-signer's "not now" answers hold a row without spending its budget
  (#47). Details are in [payout reconciliation](payout-reconciliation.md).

### `POST /api/cron/wallet-health`

- **200:** the health snapshot (`checkedAt`, `wallet`, `metrics`, `thresholds`,
  `alerts`) plus `deliveries`, each alert's Discord delivery outcome.
- **Payout state:** read-only. It raises balance, payout-volume, failure-count,
  cap and refill-overdue alerts.

### `POST /api/cron/reserve-refill`

Plans a cold-to-hot refill. It never signs or moves funds.

- **200** `{ "status": "healthy", "hotBalanceUnits", "coldBalanceUnits" }`.
- **202** `{ "status": "refill_required", "amountUnits", "hotBalanceUnits",
  "coldBalanceUnits", "coldAfterUnits" }`. Custodians sign the refill offline,
  following the [cold reserve runbook](stellar-cold-reserve-runbook.md).
- **503** `{ "status": "insufficient_reserve", "requiredUnits", "availableUnits",
  "hotBalanceUnits", "coldBalanceUnits" }`.
- **Payout state:** none.

---

## Admin-only routes

Behind the `admin_session` cookie (`middleware.ts`). They are operator tools and
not part of the public API. Most also check a role (`SUPER_ADMIN` or campaign
`CUSTOMER`). `POST /api/admin/login` and `POST /api/admin/logout` are the only
public ones.

| Methods | Route |
| --- | --- |
| POST | `/api/admin/login`, `/api/admin/logout` |
| GET | `/api/admin/auth/me` |
| GET, POST | `/api/admin/campaigns` |
| GET | `/api/admin/campaigns/template.csv` |
| GET, PATCH, DELETE | `/api/admin/campaigns/[id]` |
| GET | `/api/admin/campaigns/[id]/balance` |
| POST | `/api/admin/campaigns/[id]/deposit` |
| GET | `/api/admin/campaigns/[id]/export` |
| GET, POST | `/api/admin/campaigns/[id]/tasks` |
| PATCH, DELETE | `/api/admin/campaigns/[id]/tasks/[taskId]` |
| POST | `/api/admin/campaigns/[id]/upload` |
| GET | `/api/admin/campaigns/[id]/upload/[jobId]` |
| POST | `/api/admin/campaigns/[id]/upload/[jobId]/retry` |
| GET, POST | `/api/admin/customers` |
| DELETE | `/api/admin/customers/[id]` |
| POST | `/api/admin/customers/[id]/verify`, `/api/admin/customers/[id]/resend-verification` |
| GET | `/api/admin/disputes` |
| PATCH | `/api/admin/disputes/[id]` |
| GET | `/api/admin/export` |
| PATCH | `/api/admin/flagged-withdrawals/[id]` |
| GET | `/api/admin/health`, `/api/admin/ops` |
| POST | `/api/admin/submissions/[id]/retry` |
| PATCH | `/api/admin/tasks/[id]` |
| GET | `/api/admin/users` |
| GET, PATCH | `/api/admin/users/[walletAddress]` |

Three of them touch payout state:

- `submissions/[id]/retry` re-runs a submission payout through the same claim and
  attempt settlement as the retry cron.
- `campaigns/[id]/deposit` funds the campaign balance that `/api/submit` debits.
- `flagged-withdrawals/[id]` resolves a blocked legacy withdrawal.

`POST /api/dev/freighter-proof` is spike tooling. It answers 404 unless
`WALLET_PROOF_HARNESS=1` on testnet.

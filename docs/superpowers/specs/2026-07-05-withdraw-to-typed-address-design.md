# Design — Withdraw to a typed recipient address (paste-and-send)

**Date:** 2026-07-05 · **Trunk:** `stellar` (permanent; never merged to `develop`).

## Problem / motivation

Today a labeler links a Stellar `G…` address **once** — proving ownership by
signing a SEP-53 challenge in Freighter (ST-4b #300) — and every withdrawal is
hard-wired to that stored `user.walletAddress`. The withdraw route deliberately
**ignores any address in the request body** as a security property.

The product decision is to change this: **every withdrawal asks for the
recipient's Stellar address, typed fresh each time**, like a normal exchange
withdrawal. This makes the payout destination explicit at withdrawal time and
removes the one-time-link ceremony.

## Decisions (locked with maintainer)

1. **Fully replace the linked-wallet model.** No persistent linked wallet. Each
   withdrawal shows an empty "Recipient Stellar address" field the labeler
   pastes into.
2. **No ownership proof.** Paste a valid `G…` and send — no Freighter signature
   challenge. Accepted trade-off: a hijacked session could send to an attacker's
   address, and a typo sends USDC irreversibly to the wrong address.
3. **Trustline: precheck and reject with guidance.** If the pasted address has no
   USDC trustline, block the withdrawal with a clear message; the recipient adds
   the trustline in their own wallet. The platform-sponsored trustline flow is
   **not** offered on this path (it would require a Freighter co-sign, defeating
   paste-and-send).
4. **Confirmation step.** Because sends are irreversible and unproven, the UI
   shows a confirm step ("Send *X USDC* to `GABC…XYZ`?") before firing.

## What is retired (bypassed, not deleted)

These merged features are no longer wired into the withdrawal path. Code stays
in the repo to avoid deleting shipped work; it becomes dead on this path:

- `components/StellarWalletLink.tsx` — Freighter connect → sign → link UI.
- `app/api/me/wallet/route.ts` — SEP-53 challenge + link (ST-4b #300).
- `app/api/me/wallet/sponsor/route.ts` — sponsored USDC trustline (ST-4e #314, cap #330).

**Tension noted:** this deliberately undoes the UX that ST-4b/ST-4e/#330 built.
The routes remain importable and tested; they are simply unreferenced by the
withdrawal UI after this change.

## API changes

### `POST /api/me/withdraw`

- **Accept** `{ destinationAddress: string }` in the JSON body. This reverses the
  current "destination is never from the body" rule — an explicit, documented
  product decision (update the route's header comment to say so).
- **Validation order** (before locking any balance):
  1. Session auth (unchanged).
  2. `destinationAddress` present → else `400 missing_address`.
  3. Valid `G…` StrKey via `isValidStellarAddress` (case-sensitive, no
     normalization) → else `400 invalid_wallet`.
  4. Existing identity/eligibility gates run **against the typed address**:
     `isAnyIdentifierBanned(email, destinationAddress, userId)`,
     `checkSharedWallet(destinationAddress, userId)`,
     `checkWithdrawalEligibility(...)`. Flagged-withdrawal records use the typed
     address as `walletAddress`.
  5. USDC-trustline precheck via `accountHasUsdcTrustline(destinationAddress)`:
     - no trustline → `409 no_trustline` with the "add a USDC trustline in your
       wallet, then withdraw again" message.
     - Horizon error → `502 trustline_check_failed`.
- **Remove** the `no_wallet_linked` (400) branch and the `user.walletAddress`
  read for the destination. Keep reading the user row for `email`, `isBanned`,
  eligibility fields, and `pendingBalanceUnits`.
- **Enqueue** with the typed address: `enqueueWithdrawal(userId, destinationAddress, getMinWithdrawalUnits())`.
  The payout job already persists its own destination address; nothing is written
  back to `user.walletAddress`.
- Response shape unchanged (`status`, `withdrawalId`, `amountUnits`,
  `destinationAddress`, `token`).

### `GET /api/me/withdraw`

- **Drop** `walletLinked` from the response.
- `canWithdraw` no longer depends on a stored wallet. New definition:
  `!isBanned && eligibility.eligible && pendingBalanceUnits >= min && !hasInFlightWithdrawal`.
  Address correctness is validated at POST time, not here.
- `pendingBalanceUnits`, `thresholdUnits`, `withdrawals[]` unchanged.

## UI changes — `components/AccountSheet.tsx`

- Add a **"Recipient Stellar address"** text input to the withdraw card.
- Client-side: enable the Withdraw button only when the field parses as a valid
  `G…` StrKey **and** `canWithdraw` is true.
- **Confirm step:** on Withdraw click, show a confirmation ("Send *X USDC* to
  `GABC…XYZ`?" with the amount from `pendingBalanceUnits`) before POSTing.
- POST body carries `{ destinationAddress }`.
- Surface API errors inline / via existing toasts: `invalid_wallet`,
  `missing_address`, `no_trustline`, `below_minimum`, `withdrawal_in_flight`,
  `not_eligible`.
- **Remove** the `<StellarWalletLink>` block and the `walletLinked` field from
  the `WithdrawalData` interface.

## Error handling

| Condition | Status | Body `error` |
|---|---|---|
| No address in body | 400 | `missing_address` |
| Malformed / non-`G…` address | 400 | `invalid_wallet` |
| Address lacks USDC trustline | 409 | `no_trustline` (+ guidance `message`) |
| Trustline check Horizon failure | 502 | `trustline_check_failed` |
| Below minimum | 400 | `below_minimum` |
| Withdrawal already in flight | 409 | `withdrawal_in_flight` |
| Banned identity / shared wallet | 403 | `identity_banned` / `shared_wallet_detected` |
| Not eligible | 403 | `not_eligible` |

## Testing

- `app/api/me/withdraw/__tests__/route.test.ts`:
  - POST: valid typed address → `queued`, address passed to `enqueueWithdrawal`.
  - POST: missing address → `400 missing_address`.
  - POST: malformed / lowercased `G…` → `400 invalid_wallet`.
  - POST: valid address without trustline → `409 no_trustline`.
  - POST: trustline check throws → `502 trustline_check_failed`.
  - Existing ban/shared-wallet/eligibility/below-minimum/in-flight cases retargeted
    to the typed address.
  - GET: response no longer includes `walletLinked`; `canWithdraw` reflects the
    new definition.
- No new test file needed; the wallet-link and sponsor route tests are unchanged
  (those routes are untouched, just unreferenced).

## Out of scope

- Deleting the retired routes/components (kept to preserve shipped work).
- Re-introducing any ownership proof or address allow-listing.
- Persisting a "last used address" (explicitly not remembered).
- Admin-side wallet lookups (separate ST-5b follow-up).

## Demo/env note

Unrelated to this change but required for the live demo: `.env.local` must carry
the Stellar testnet block (`STELLAR_NETWORK=testnet`, `STELLAR_USDC_ISSUER`,
`STELLAR_PLATFORM_SECRET`, `MIN_WITHDRAWAL_UNITS`, `PLATFORM_FEE_UNITS`,
`NEXT_PUBLIC_REWARD_TOKEN_DECIMALS=7`, `NEXT_PUBLIC_REWARD_TOKEN_SYMBOL=USDC`),
and the platform account needs faucet USDC. Tracked separately from this spec.

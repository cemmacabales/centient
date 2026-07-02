# ST-4e — Sponsored USDC Trustlines for Recipients (CAP-33)

**Issue:** #314 · **Roadmap:** #289 (Wave 4 tail) · **Branch:** feature branch off `stellar`, PR targets `stellar` (never `develop`).

## Problem

Native XLM needs no trustline — a `G…` receives XLM with zero setup. **USDC cannot.** To receive USDC an account must (1) **exist** (hold the ~1 XLM base reserve) and (2) hold a **USDC trustline** (an extra 0.5 XLM reserve). A labeler earning cents of USDC in an emerging market will not hold ~1.5 XLM, so without intervention they can never receive a payout.

Today (ST-4b, `app/api/me/wallet/route.ts:119`), an untrusted `G…` is hard-rejected at link time with a 409 `no_trustline` — a dead-end funnel that contradicts the product goal ("anyone with a phone can earn instantly — no bank account needed").

## Decision: sponsored reserves (CAP-33)

The platform **sponsors** the recipient's reserves so the labeler needs **0 XLM**. Using `beginSponsoringFutureReserves` / `endSponsoringFutureReserves` wrapping the recipient's `changeTrust`, the 0.5 XLM trustline reserve (and ~1 XLM base reserve, if the account must be created) is locked on the **platform** account, refundable if the sponsorship is later revoked. The recipient still **signs** (it is their account) but **pays nothing**.

Scope of this spec: **the full issue** — sponsored trustline for funded accounts, the sponsored account-creation branch for brand-new 0-XLM accounts, and wallet-health XLM-floor reserve accounting.

## Architecture

Two-signature flow, **server-orchestrated, server submits** (chosen over client-submit for unified Horizon result-code handling and keeping the platform secret + submission server-side). The platform's signature is over a fixed envelope, so a tampered client cannot change the operations without invalidating it.

```
StellarWalletLink (browser)                Server                         Horizon
  connect() → G…
  GET /api/me/wallet/sponsor?address ───▶  accountHasUsdcTrustline?
                                           loadAccount(G) → exists / 404
                                           build CAP-33 sandwich
                                           platform-sign → xdr
  ◀── { needed, xdr, kind } ──────────────
  signTransaction(xdr) [Freighter]
  POST /api/me/wallet/sponsor ──────────▶  re-assert op shape + target
     { address, signedXdr }                submitTransaction ───────────▶ (established)
  ◀── { established:true } ────────────────
  GET /api/me/wallet?address (challenge)   ← existing ST-4b link+prove
  signOwnership() [SEP-53]                    flow, unchanged; trustline
  POST /api/me/wallet (bind) ────────────▶   precheck now passes
```

### Units / components

**1. Chain primitives — `lib/stellar/client.ts`**

- `buildSponsoredTrustlineTx(recipientG: string): Promise<{ xdr: string; kind: "trustline" | "account+trustline" }>`
  - Load the **platform** account (sequence source + fee source).
  - `loadAccount(recipientG)` to detect existence (Horizon 404 → account does not exist).
  - **Account exists** — build:
    1. `Operation.beginSponsoringFutureReserves({ sponsoredId: recipientG })` — source: platform (implicit tx source)
    2. `Operation.changeTrust({ asset: usdcAsset() })` — source: `recipientG` (default limit = max)
    3. `Operation.endSponsoringFutureReserves()` — source: `recipientG`
  - **Account does not exist (404)** — insert between (1) and (2):
    - `Operation.createAccount({ destination: recipientG, startingBalance: "0" })` — source: platform (CAP-33 covers the base reserve)
  - `kind` = `"account+trustline"` when the createAccount op is present, else `"trustline"`.
  - Fee = `base_fee × numOps`, paid by platform. `setTimeout(TX_TIMEOUT_SECONDS)` (reuse existing constant).
  - Platform-signs (`platformKeypair()`), returns `tx.toXDR()`.
  - **Sequence strategy (simple):** do **not** hold `seqMutex` across the browser round-trip. The tx is built from the platform's current sequence and submitted later; a concurrent `payUsdc` may consume that sequence first.
- `submitSponsoredTrustline(signedXdr: string): Promise<{ hash: string }>`
  - Rebuild the `Transaction` from `signedXdr` + `networkPassphrase()`.
  - **Re-assert op shape** (defense in depth): ops are exactly the begin / [createAccount] / changeTrust / end sandwich; the sponsored target and `changeTrust` source equal one `G…`; `changeTrust` asset equals `usdcAsset()`; no other op types (esp. no `payment`). Reject mismatches with a non-retryable error.
  - `submitTransaction`. Map result codes via the existing `resultCodes()` helper:
    - `op_low_reserve` (platform lacks XLM for the sponsored reserves) → **non-retryable** `StellarPaymentError("op_low_reserve", retryable:false)` → surfaced as "payouts temporarily unavailable" (wallet-health should already be paging).
    - `tx_bad_seq` → **retryable** error → client re-runs the whole sponsor flow (rebuild → re-sign → resubmit).
    - success → established. An already-trusted race resolves as success too: `changeTrust` on an existing line is idempotent (it just re-sets the limit), so a duplicate submission is harmless.
  - Reuse `StellarPaymentError` (rename note: message/`context` should read `sponsor-trustline`, not `payUsdc`).

**2. Wallet client — `lib/stellar/wallet.ts`**

- `signTransaction(xdr: string, expectedAddress: string): Promise<string>` — wraps Freighter's `signTransaction(xdr, { address, networkPassphrase })`, returns the signed XDR. Asserts the connected signer matches `expectedAddress` (case-sensitive). Albedo stays connect-only and **throws** the same guidance as `signOwnership` (no SEP-53 / no server-verifiable signing path yet).
- **Testnet risk to prove:** Freighter must sign for a **not-yet-funded** keypair (the account-creation branch). Confirm on testnet that Freighter signs an unfunded account's transaction rather than blocking.

**3. API — `app/api/me/wallet/sponsor/route.ts`** (new)

- Auth: `getLabelerSession` + `requireLabelerSession` (same as the link route).
- `GET ?address` — validate `isValidStellarAddress` (never lowercased). If `accountHasUsdcTrustline(address)` → `{ needed: false }`. Else `buildSponsoredTrustlineTx(address)` → `{ needed: true, xdr, kind }`. On Horizon failure → 502.
- `POST { address, signedXdr }` — validate address; `submitSponsoredTrustline(signedXdr)`. Map: established → `{ established: true }`; `op_low_reserve` → 503 `{ error: "sponsorship_unavailable" }`; `tx_bad_seq` → 409 `{ error: "retry" }`; shape mismatch → 400. Sentry-capture unexpected errors.
- Throttle with the existing `checkWalletRateLimit(address)` (same limiter the link GET uses) to bound tx-build churn.

**4. Withdrawal UX — `components/StellarWalletLink.tsx`**

New sequence inside `handleLink`:
1. `connect()` → `address`.
2. `GET /api/me/wallet/sponsor?address`. If `needed`: `signTransaction(xdr, address)` → `POST /api/me/wallet/sponsor`. On `{ error: "retry" }`, retry the sponsor GET→sign→POST once, then surface a friendly "please try again". On `sponsorship_unavailable`, show "Payouts are temporarily unavailable, try again shortly."
3. Existing challenge → `signOwnership` → bind POST (unchanged). The trustline now exists, so the link precheck passes.

Copy: the sponsorship step is presented as **"Set up USDC payouts (free)"** — emphasize the labeler pays nothing. The dead-end `no_trustline` toast is removed from the normal path (the link POST keeps the 409 as a final guard only).

**5. Reserve accounting — `lib/stellar/balance.ts`**

- Read `num_sponsoring` from the platform `account` (already loaded for balances; Horizon exposes it on the account record). No DB.
- Compute **available XLM = xlmBalance − 0.5 × num_sponsoring** (the sponsored-reserve liability), and pass that available figure — not the raw balance — into `evaluateThresholds` against the existing `warnXlm`/`pageXlm`. This is the single chosen approach (subtract liability from balance; do not mutate the thresholds), so the floor is unchanged in meaning but now reflects locked reserves.
- Surface `numSponsoring` and the computed reserve liability in `WalletHealth` and `/api/health/wallet` so the admin status card reflects it. Remove the now-satisfied ST-4e TODO comment (`balance.ts:66`).

## Data flow & state

Three recipient states, surfaced cleanly to the UI:
- **ready** — account exists and holds the USDC trustline → `needed:false`, go straight to bind.
- **needs_trustline** — account exists, no trustline → `kind:"trustline"`.
- **needs_account** — account does not exist on-chain (404) → `kind:"account+trustline"`.

No new persistent state. Sponsorship liability is derived live from Horizon `num_sponsoring`; the wallet address binding continues to live on `User.walletAddress` via the unchanged ST-4b link flow.

## Error handling

| Condition | Where | Handling |
|---|---|---|
| Recipient rejects signing | Freighter | `signTransaction` throws → toast, no submit |
| Platform out of XLM (`op_low_reserve`) | submit | non-retryable → 503 `sponsorship_unavailable`; wallet-health pages |
| Sequence race (`tx_bad_seq`) | submit | retryable → 409 `retry`; client re-runs flow once |
| Tampered / wrong-shape XDR | submit pre-check | 400, non-retryable |
| Horizon unavailable | build / submit | 502, Sentry-captured |
| Trustline already exists (race) | submit | treated as established (idempotent) |

## Testing

- `lib/stellar/__tests__/client.test.ts`
  - `buildSponsoredTrustlineTx`: exists-case has the begin/changeTrust/end sandwich; platform is fee + sequence source; `changeTrust` is sourced by the recipient with `usdcAsset()`; envelope requires both signatures.
  - 404-case additionally contains `createAccount(recipient, "0")` and `kind === "account+trustline"`.
  - `submitSponsoredTrustline`: rejects a tampered envelope (extra `payment` op / wrong sponsored target); maps `op_low_reserve` non-retryable and `tx_bad_seq` retryable.
- `app/api/me/wallet/sponsor/__tests__/route.test.ts`
  - GET returns `needed:false` when a trustline exists; `needed:true` + `xdr`/`kind` otherwise.
  - POST established path; `op_low_reserve` → 503; `tx_bad_seq` → 409 retry.
- `app/api/me/wallet/__tests__/route.test.ts` (extend)
  - After a sponsored trustline is established, the existing bind + subsequent USDC payout path succeeds (no more hard `no_trustline` reject on the happy path).
- `lib/stellar/__tests__/balance.test.ts` (extend)
  - XLM floor reflects `0.5 × num_sponsoring`: an otherwise-healthy XLM balance pages/warns once sponsorship liability is subtracted.

## Acceptance criteria (from #314)

- A brand-new Stellar account with **0 XLM** can be onboarded to receive USDC via a platform-sponsored trustline, sign it, and receive a lump-sum USDC payout confirmed on stellar.expert (testnet).
- Wallet-health XLM floor accounts for outstanding sponsorship reserves.

## Out of scope / follow-ups

- Sponsorship **revocation / reclaim** of reserves when a user unlinks — reserves stay locked on the platform until a future cleanup job; noted for a later ticket.
- The robust fee-bump sequence strategy (recipient as tx source for the exists-case) — deferred; the simple retry-on-`tx_bad_seq` is used instead.
- Feeds ST-3c (#297) reserve accounting (delivered here) and ST-7 (#308) mainnet reserve funding sizing (consumes `num_sponsoring` liability).

# MiniPay Simulation Mode — Design

**Date:** 2026-06-16
**Status:** Approved (pending spec review)
**Branch:** `feat/minipay-simulation-mode`

## Problem

The labeler ("user") surface (`app/page.tsx`) authenticates **only** through an
injected browser wallet. On a desktop browser with no wallet, the only login
button — "Continue with MetaMask" — throws `"MetaMask is not installed"`
(`lib/metamask.ts:18`). There is no email/password path for labelers (that's
Admin/Customer only) and no dev bypass. This blocks local testing and demoing of
the full labeler flow without installing MetaMask or using a MiniPay Android device.

## Goal

A **local-dev-only** mode that simulates running inside MiniPay end-to-end —
login *and* payout — so the entire labeler flow can be demonstrated with no
MetaMask, no MiniPay account, and no Celo network connection. Requires **no real
wallet** and links **no real MiniPay account**: the simulated identity is a
local throwaway test key.

## Non-Goals

- No changes to the real auth flow (`/api/auth/nonce`, `/api/auth/verify`).
- No new server endpoints (no `/api/auth/dev-login`).
- No production behavior changes. The feature is hard-off in production.
- Not simulating the Admin/Customer email-password login (already works locally).

## Key Findings (how the real flow works)

- **Login is fully offline.** `/api/auth/nonce` issues a DB nonce → the wallet
  does `personal_sign` → `/api/auth/verify` recovers the signing address from the
  signature (`verify/route.ts:46`) and checks it matches. No RPC, no chain, no
  MiniPay servers. There is **no wallet allowlist** — any address that can sign
  authenticates and is lazily created as a `User`.
- **Payout funnels through one function.** `app/api/submit` only enqueues a
  `payoutJob` (`payoutStatus: "pending"`). A separate worker process
  (`pnpm payout` → `lib/payout-worker.ts`) and the retry service
  (`lib/payout-service.ts`) both call **`payReward()` in `lib/payout.ts`** — the
  single place an on-chain ERC-20 transfer happens. The client polls
  `/api/submissions/:id` until `payoutStatus === "sent"`.

These two facts give exactly two surgical simulation chokepoints: the client
wallet (for login) and `payReward()` (for payout).

## Design

### 1. Single source of truth — `lib/simulation.ts`

```ts
export function isSimulationMode(): boolean {
  return process.env.NODE_ENV !== "production"
    && process.env.NEXT_PUBLIC_SIMULATE_MINIPAY === "1";
}

// Well-known local dev key, overridable via env. NOT for any real funds.
export const SIMULATED_WALLET_PRIVATE_KEY =
  (process.env.SIMULATED_WALLET_PRIVATE_KEY
    ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as `0x${string}`;

export function simulatedAddress(): `0x${string}`; // privateKeyToAccount(...).address, lowercased
```

**Double-gated:** the flag is inert unless `NODE_ENV !== "production"`, so the
simulation can never fire on a real deploy even if the env var leaks. A single
flag (`NEXT_PUBLIC_SIMULATE_MINIPAY=1`) drives both chokepoints; it is readable
on the client (shim) and in the worker/server process (payout).

**Wallet identity:** **fixed** dev key (decided). Same labeler every run, so
onboarding state and earnings persist across reloads — better for demos. Clearly
a synthetic account, never a real MiniPay account.

### 2. Client wallet shim — `components/MiniPaySimulator.tsx`

- A `"use client"` component rendered high in `app/layout.tsx`.
- When `isSimulationMode()`, it installs `window.ethereum` **synchronously during
  render** (idempotent, guarded by `typeof window` and an install flag), so it
  exists before `app/page.tsx`'s mount effect runs `isMiniPay()`.
- The injected provider:
  - `isMiniPay: true`
  - `request({ method })`:
    - `eth_requestAccounts` / `eth_accounts` → `[simulatedAddress()]`
    - `personal_sign` → real local signature via viem
      (`privateKeyToAccount(SIMULATED_WALLET_PRIVATE_KEY).signMessage(...)`)
    - other methods → benign no-op / resolve
- Effect: the app auto-connects exactly like MiniPay; `/api/auth/verify` passes
  because the signature is **genuinely valid** (just from a local key). No server
  auth changes. Off by default, so normal landing/MetaMask testing is untouched.

### 3. Payout short-circuit — `lib/payout.ts`

- At the top of `payReward(to, amountWei)`: if `isSimulationMode()`, skip
  `writeContract` and return a random well-formed `0x` + 64-hex hash. No RPC, no
  Celo, no `PAYOUT_PRIVATE_KEY` needed.
- Same guard in `waitForTx(hash)`: return a synthetic `status: "success"` receipt
  so the reconcile cron (if run) marks the submission `confirmed` instead of
  failing on a non-existent tx.
- Everything downstream is unchanged: worker sets `payoutStatus: "sent"`, persists
  the txHash, credits user totals; the client poll flips the success screen and
  updates the balance.

### 4. Hide explorer link in sim mode — `app/page.tsx` (success screen)

- The success screen links to `${EXPLORER_URL}/tx/${lastTxHash}`. The fake hash
  would 404. When `isSimulationMode()` (via the public flag), render the "Paid"
  copy **without** the "View on explorer" link. Decided: hide it.

## Data Flow (simulated)

```
load app
  → MiniPaySimulator installs window.ethereum (isMiniPay=true)
  → page.tsx isMiniPay() === true → connectMiniPay() → eth_requestAccounts → sim address
  → /api/me (new user → onboarding)
  → signInLabeler: nonce → personal_sign (local key) → /api/auth/verify (passes) → session cookie
  → onboarding → landing → task
submit task
  → /api/submit → submission "pending" + payoutJob "queued"
  → worker (pnpm payout) → payReward() [SIM: returns fake hash, no chain]
  → submission "sent" + txHash, user totals credited
  → client poll → success screen (balance updated, no explorer link)
```

## Files Touched

| File | Change |
|------|--------|
| `lib/simulation.ts` | **new** — `isSimulationMode()`, sim key, `simulatedAddress()` |
| `components/MiniPaySimulator.tsx` | **new** — client wallet shim |
| `app/layout.tsx` | render `<MiniPaySimulator />` |
| `lib/payout.ts` | sim guard in `payReward()` and `waitForTx()` |
| `app/page.tsx` | hide explorer link when sim mode |
| `.env.local.example` | document `NEXT_PUBLIC_SIMULATE_MINIPAY` and `SIMULATED_WALLET_PRIVATE_KEY` |

## Testing (TDD)

- `isSimulationMode()`: on only when flag=`1` **and** `NODE_ENV !== production`;
  hard-off in production even with the flag set.
- `payReward()`: in sim mode returns a syntactically valid `0x…64hex` hash and
  performs **no** RPC / `writeContract`; outside sim mode, unchanged behavior.
- `waitForTx()`: sim mode returns a success receipt without RPC.
- `MiniPaySimulator` provider `request`: returns sim address for
  `eth_requestAccounts`; produces a signature that `recoverMessageAddress`
  resolves back to `simulatedAddress()` (round-trip), proving `/api/auth/verify`
  will accept it.

## How to Run the Demo

1. Add to `.env.local`: `NEXT_PUBLIC_SIMULATE_MINIPAY=1`
2. `pnpm dev`
3. `pnpm payout` (worker, in a second terminal — required for payout to complete)
4. Open the app → auto-connects → onboarding → submit a task → "Paid" with updated balance.

## Safety

- Hard-off when `NODE_ENV === "production"`, independent of the flag.
- No new endpoints; the real verify path is exercised (real signatures).
- Default flag value is unset (off); existing dev/test workflows unaffected.

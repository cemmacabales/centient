# First-connect onboarding: wallet identity is the USDC payout destination (#30)

Epic 2 · issue 7 of 8 · depends on #29 · manual QA in #31.

## Problem

By #29 every piece of wallet onboarding existed, but not as one flow:

- **Sign-in (#25, #26)** made the proven address the account's `walletAddress`, then went straight to onboarding.
- **Sponsorship (#27, #28)** was reachable only from `StellarWalletLink`, a "link payout wallet" button that no screen rendered after the 2026-07-05 paste-and-send change.
- **Withdrawals** paid whatever `G…` address the request body carried, with no ownership proof.
- **Email/password** registration and login still created accounts that could earn with no wallet at all (ST-5d).
- **#29's handoff:** a sponsored address that is no user's `walletAddress` becomes reclaim-eligible once its owner holds XLM, so first connect must bind the wallet no later than it sponsors it.

## Decision

The address a contributor proves is the account, and it is the account's only payout destination.

| Path | Before | After |
|---|---|---|
| `POST /api/auth/register` | creates an email/password account | **410** `email_registration_retired` |
| `POST /api/auth/login` | email sign-in | unchanged; now only the way into the claim path |
| `GET/POST /api/me/wallet` | proves an address, requires a USDC trustline, then overwrites `walletAddress` | proves and **binds before any sponsorship**, with no trustline precheck; binds only onto an account with no wallet or a legacy `0x…`; the same wallet again succeeds; a different wallet is **409** `wallet_already_bound` |
| `GET/POST /api/me/wallet/sponsor` | sponsors any address the client names | sponsors **only the session's bound wallet**; another address is **403** `address_not_bound`; no bound Stellar wallet is **409** `wallet_required`; GET returns the resolved `address` |
| `POST /api/me/withdraw` | pays the body's `destinationAddress` | pays the **bound wallet**; none is **409** `wallet_required`; a mismatched body address is **403** `address_not_bound`; no trustline is **409** `payout_setup_required` |
| `GET /api/task`, `POST /api/submit` | serve and accept work for any session | **409** `wallet_required` without a bound wallet (409 rather than 403, which the client reads as a ban) |

### Legacy email accounts — decided 2026-09-15

On 2026-09-15, staging held 10 email-only accounts, 5 of them with a balance, plus 4 email accounts with a linked wallet and 5 wallet-only accounts. `cemmacabales` chose the **legacy claim path** over removing email entirely:

- **No new email accounts:** registration is retired.
- **Claim once, then wallet sign-in:** an existing email account signs in, connects Freighter and binds that wallet. From then on it signs in with the wallet, and its balance stays with the account.
- **Nothing before the claim:** until it binds a wallet, the account can neither earn nor withdraw.

## Flow

```
            ┌────────────┐  Freighter sign-in (#25/#26)
signed out ─┤   login    ├──────────────────────────────┐
            └─────┬──────┘                              │
                  │ email sign-in (existing accounts)   │
                  ▼                                     ▼
            ┌────────────┐  bind proven wallet   ┌──────────────┐  ready   ┌─────────────────────┐
            │claim_wallet├──────────────────────►│ payout_setup ├─────────►│ onboarding / landing │
            └────────────┘  (/api/me/wallet)     └──────────────┘          └─────────────────────┘
                                                   sponsor GET → already trusts USDC: ready
                                                   else co-sign in Freighter → sponsor POST
```

`app/page.tsx` resolves every session through `resolveSession`: Freighter sign-in, email sign-in and a reload all take the same route.

- **Signed out:** `login`.
- **No Stellar wallet, or a legacy `0x…` one:** `claim_wallet`.
- **Otherwise:** `payout_setup`, which a returning wallet that is already set up passes through without a signature.

Payout setup never blocks the app (PR #105 review). Tasks and submissions need only a bound wallet, so a failed setup offers **Continue for now** beside **Try again**, and the contributor goes on to onboarding or the landing. A withdrawal refused `payout_setup_required` sends them back to `payout_setup`. If Horizon cannot say whether the trustline exists, a confirmed sponsorship on the ledger answers `needed:false`; the withdrawal still checks the chain.

A 409 `wallet_required` from task or submit also routes to `claim_wallet`.

The client flows are resolve-never-reject libraries with injectable dependencies, in the pattern `wallet-sign-in.ts` set: `lib/stellar/payout-setup.ts` and `lib/stellar/wallet-claim.ts`. Each failure is a typed state with a message, rendered by a stateless view (`PayoutSetupView`, `WalletClaimView`) with a thin container.

## Recovery

| Situation | What happens | Why nothing duplicates |
|---|---|---|
| Sign-in or claim prompt declined | Guidance state; try again | Nothing was signed; a new challenge is issued |
| Sponsorship prompt declined | `rejected` state; try again rebuilds | Nothing was submitted |
| Submit outcome unknown (202) | `pending` state; a reload answers `submission_pending` until it resolves | The pending row stays; resubmitting the same envelope settles on that row (#27) |
| Submit refused `retry` (`tx_bad_seq`, never landed) | Rebuilt and re-signed once, automatically | The first row is released as `failed`; one live row remains |
| Sponsor route throttled | The flow waits out its `Retry-After` once (up to 60s), then carries on | A throttled request writes nothing; each throttle allows 5 requests a minute, so a rebuild or a reload does not trip it |
| Setup fails and cannot recover now | **Continue for now** into the app; withdrawing sends the contributor back to setup | Nothing was submitted, or the pending row stays |
| Trustline removed after a confirmed sponsorship | A new envelope is broadcast, not answered `already_confirmed` | The confirmed row is released (nothing still sponsored) or reopened as pending (account still sponsored) |
| Existing trustline | Sponsor GET answers `needed:false`: ready | No envelope, no row, cap untouched |
| Returning wallet | Signs in as the same user; passes setup | `findOrCreateWalletUser` keys on the unique `walletAddress` |
| Wallet held by another account | Claim refused `address_already_linked` | `User.walletAddress` is unique |
| Legacy email user pressed "Connect Freighter" first | The empty wallet-only account that sign-in created is removed and the claim binds the wallet to the email account, sponsorship rows included | Only an account with no email, password, work, earnings, balance, withdrawals, flags, disputes or bans is taken over, in one transaction that locks it first |
| Second wallet on a bound account | Claim refused `wallet_already_bound` | Bind is conditional on no usable wallet |
| Tab closed mid-flow | Reload resumes at the unfinished step | Every step is idempotent against the ledger |

## Session and logout

Sessions are unchanged: a 7-day HS256 `labeler_session` cookie keyed on `User.id`. Logout (`POST /api/auth/logout`) clears it with `Max-Age=0`, after which `/api/auth/me` answers `authenticated:false` and every onboarding route answers 401.

## Key custody

A contributor signs only in Freighter. That covers the SEP-53 sign-in and claim challenges and the co-signature on the sponsored envelope. Centient receives public addresses, signatures and signed envelopes. `lib/__tests__/contributor-key-custody.test.ts` pins this down with two kinds of check:

- **Static scan:** no module on the first-connect path, client or server, reads, parses, builds or asks for a secret seed.
- **Signing and inputs:** signing goes through `@stellar/freighter-api`, and the onboarding routes read only address, signature and envelope fields.

Platform keys are unaffected. This change adds no secret to any service, so F-01's single-deployment custody guard still holds as it was.

## Residual risks

- **Logout does not revoke the token.** A copied token stays valid until it expires (7 days). This predates #30.
- **Phones:** Freighter is desktop-only here, and Freighter Mobile needs WalletConnect v2, which no Epic 2 issue builds (ADR-0003).
- **Stale pending rows:** one reconciles only through an operator reclaim run (#29). The request path answers `submission_pending` until its envelope expires.
- **Two claimants of one wallet:** an email account and a wallet-only account cannot share one. If the wallet-only account is unused (PR #105 review), the email account's claim takes the wallet over. Otherwise the claim is refused and its owner must pick one account; no merge path exists for two accounts that both have activity.
- **Legacy `0x…` wallets:** such an account is treated as having no wallet. Its first claim replaces the `0x…` value.

# ADR-0009: Ask for payout setup's signature at sign-in on the Freighter mobile app

- **Status:** Accepted — 2026-09-30
- **Scope:** Contributor onboarding on the Freighter mobile app (WalletConnect): sign-in and USDC payout setup.
- **Relates to:** [#170](https://github.com/webnxt-2030/Centient/issues/170) (this change), [#25](https://github.com/webnxt-2030/Centient/issues/25) / [#26](https://github.com/webnxt-2030/Centient/issues/26) (wallet sign-in), [#28](https://github.com/webnxt-2030/Centient/issues/28) / [#30](https://github.com/webnxt-2030/Centient/issues/30) (sponsored trustline, payout setup), #330 (sponsorship cap), [#137](https://github.com/webnxt-2030/Centient/issues/137) (Freighter Mobile). Follows the amendment to [ADR-0003](0003-freighter-only-wallet-support.md).

## Context

On a phone, every signature Freighter makes is a trip out of the browser: the
browser hands off to the Freighter app, the contributor approves, and they
switch back. On iOS each hand-off also shows Safari's "Open this page in
'Freighter'?" prompt.

A new wallet needed three trips: pair (connect), sign the SEP-53 challenge
(sign-in), and co-sign the sponsored USDC trustline (payout setup). A Week 3
tester recorded the whole thing on an iPhone 11 (2026-09-24): about 1m45s from
**Open Freighter app** to **Before you start**. She called it "a hassle… longer
than it needed to be."

The three steps are serial, and iOS Safari freezes the page while Freighter is
in front:

- The challenge can only be signed once the page hears that the pairing was
  approved.
- The trustline envelope was only built after sign-in, because
  `GET /api/me/wallet/sponsor` needs a session.

So the page did nothing until the contributor came back, then sent them out
again. The pairing can't be merged with a signature: WalletConnect sends no
request before a session exists, and Freighter implements no one-click auth. The
two signatures can be merged: Freighter mobile queues session requests and
shows them one after another.

## Decision

On the mobile transport (`batchesSignatures()`), sign-in asks for payout
setup's signature in the same Freighter visit as its own proof:

1. `POST /api/auth/wallet/challenge` takes `payoutSetup: true`. It answers with
   `sponsorship: { xdr, kind, offer, expiresAt }` when the address needs a
   trustline, has no pending sponsorship, and the envelope can be built.
   Otherwise the challenge comes back alone. Building the offer never fails
   sign-in.
2. The client sends `stellar_signMessage`, then `stellar_signXDR`, and brings
   Freighter forward once (`signOwnershipAndTransaction`). Sign-in completes on
   the proof alone. The transaction is handed to payout setup in memory
   (`handOffPayoutSignature`).
3. Payout setup submits that envelope with its `offer`. It falls back to
   building and signing afresh when the envelope has expired, or is refused as
   one this session can't use (`retry`, `invalid_sponsor_tx`,
   `address_not_bound`). If the transaction is still unanswered after
   `BATCHED_ANSWER_GRACE_MS`, Freighter is brought forward for it, as a request
   of its own would be.

**The offered envelope carries no sponsor signature.** Anyone can ask for a
challenge, and #330's per-user cap needs a user. A sponsor-signed envelope
handed out there would be a bearer instrument for the sponsor's reserves: a
caller looping fresh keypairs could co-sign and broadcast sponsorships past the
cap. The sponsor signs in `prepareSponsoredTrustline`, which the sponsor route
calls only after the session, the bound-wallet check and the #330 gate.

The sponsor's signature on a `GET` envelope also proved the sponsor built it.
For an offered envelope, `offer` does that job: an HMAC-SHA256 over the
envelope's hash, keyed by a label-separated hash of the sponsor's secret. The
envelope hash commits to every field and the network, so a changed envelope, or
another envelope's tag, is refused before anything is signed.

The desktop extension path is unchanged. Its prompts open in the same browser,
so there is no trip to save.

## Consequences

- **A new wallet on a phone visits Freighter twice, not three times:** connect,
  then sign-in and USDC setup back to back. A wallet that already trusts USDC is
  unchanged (connect, then sign-in).
- The challenge route reads Horizon on `payoutSetup: true` (the trustline check,
  plus the build's sponsor and ledger reads). It is still behind the per-IP and
  per-address throttles, and nothing it builds can be broadcast by the caller.
  The SDK waits on Horizon forever by default, so the offer is bounded at
  `PAYOUT_SETUP_OFFER_DEADLINE_MS` (4 s). Past that, the challenge goes out
  alone, and the wallet takes today's three trips.
  On testnet, directly submitting a co-signed offer was refused with
  `tx_bad_auth`.
- The offer lives 180 seconds, like any sponsorship envelope. If the sponsor's
  sequence moves in that time, the submit answers `retry` and payout setup asks
  for a new signature: one extra trip, as before this change.
- `POST /api/me/wallet/sponsor` takes an optional `offer`. The key-custody test
  (#30) now pins that field: it is public, like the envelope it vouches for.
- The tester guides' "Trip 3" wording is out of date once this ships, and needs
  a follow-up.

## Alternatives considered

**Sign only the trustline envelope, and accept its signature as the sign-in
proof.** One signature instead of two. Rejected: it changes the #25 verify
contract, only helps new wallets, and makes the first thing a contributor signs
a transaction behind Freighter's "does not appear safe" warning, rather than a
message that says it moves no funds.

**Open Centient inside Freighter's own browser.** No trips at all, since the
page and the wallet share one app. Kept as a possible tester-guide tip. It needs
an iPhone run first (#137's AC-9 has no recorded result), and it helps only
contributors who know to do it: Freighter has no link that opens a URL in its
browser.

**Issue the sponsor-signed envelope at sign-in, and rely on the challenge
throttles.** Rejected for the reserve-drain reason above.

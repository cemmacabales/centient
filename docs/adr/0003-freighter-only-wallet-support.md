# ADR-0003: Support Freighter only; descope Albedo from Deliverable 2

- **Status:** Accepted — 2026-09-14, **amended 2026-09-22** (see *Amendment: Freighter Mobile over WalletConnect*)
- **Scope:** Deliverable 2 (wallet-native contributor onboarding) and everything built on it in Deliverables 3–4.
- **Relates to:** [#21](https://github.com/webnxt-2030/Centient/issues/21) (Epic 2), [#24](https://github.com/webnxt-2030/Centient/issues/24) (wallet signing spike), [#26](https://github.com/webnxt-2030/Centient/issues/26) (wallet-connect session), [#28](https://github.com/webnxt-2030/Centient/issues/28) (sponsored trustline + fee bump), [#31](https://github.com/webnxt-2030/Centient/issues/31) (Epic 2 QA), SOW §3.1, §4.1, §5.1, §6.

## Context

The SOW names **"Freighter / Albedo"** three times: the §3.1 Key Outcome, the
Deliverable 2 description in §4.1, and the Week 2 planned work in §5.1. Epic 2's
issues were written from that text and required parity between the two wallets.

None of the SOW's acceptance criteria name a wallet:

- **§6.1, Deliverable 2 evidence:** "a short recording of Stellar wallet connect →
  signed-challenge → session issued for a contributor's address, with no email or
  password."
- **§6.3 success metrics:** unique Stellar wallet addresses onboarded, and
  contributors receiving USDC with no XLM of their own.
- **§5.1 Week 2 expected output:** "a user connects a Stellar wallet and signs in."

One wallet meets every one of them.

What the codebase held was not two wallets either. Albedo was wired only as a
**connect-only fallback** in `lib/stellar/wallet.ts`: when Freighter was absent,
`connect()` returned an Albedo address, and then both `signOwnership()` and
`signTransaction()` threw. A contributor who connected with Albedo could not
prove ownership or co-sign a sponsored trustline — the two things the module
exists to do.

The #24 spike found Albedo is technically closer than that code assumed:

- Since its "Merge SEP53 support" commit (`fbf9cabe`, 2025-06-13), albedo.link's
  `sign_message` returns a SEP-53 signature in an undocumented `signedMessage` hex
  field, next to its legacy `message_signature` over `SHA256("<pubkey>:<message>")`.
  `@albedo-link/intent` 0.13.0 does not type or document the new field.
- Albedo's `tx` intent signs an app-supplied XDR without submitting it, but builds
  a signature schema from Horizon first. Whether that tolerates a sponsored
  envelope whose operation source does not exist yet is unproven.

Closing those two gaps means a second signing adapter, a second testnet proof,
and a second full identity/onboarding matrix in QA #31. That all has to land
inside a Week 2 whose seven implementation issues are fully serial with no slack.

## Decision

Deliverable 2 supports **Freighter only**. Albedo is descoped:

- Remove the Albedo connect fallback, its signature helper, and the
  `@albedo-link/intent` dependency.
- When Freighter is not reachable, every wallet action fails with one install
  message instead of falling through to a wallet that cannot finish the flow.
- Rewrite Epic 2's issues (#19, #21, #24, #26, #28, #31, #32, #34) from
  "Freighter and Albedo" to Freighter.

## Consequences

- **The Deliverable 2 evidence package must state this decision.** Its
  description in the SOW still reads "Freighter / Albedo"; a reviewer comparing
  the two should find the divergence recorded, not discover it.
- **Phones are not covered by this decision, and that is the real cost.**
  `@stellar/freighter-api` talks to the Freighter *browser extension*. Freighter
  Mobile is reachable only over WalletConnect v2 (`stellar_signMessage`,
  `stellar_signXDR`), and no Epic 2 issue builds a WalletConnect client. Albedo,
  a web signer, would have worked in a mobile browser. The SOW's §3.1 says
  "anyone with a phone", and Deliverable 3 is mobile-first — so until
  WalletConnect lands, a contributor needs desktop Freighter to onboard.
- The ≥ 25-wallet adoption target (#49) is exposed to the same limit. If the
  Philippines chapter cohort is phone-first, that target depends on
  WalletConnect, not on Albedo.
- One signing scheme remains: SEP-53 for messages and a plain co-signed envelope
  for transactions. `SignatureScheme` narrows to `"sep53"`.

## Reopen criteria

Revisit if any of these happen first:

- the Ambassador Chapter Lead or SDF review requires Albedo specifically;
- mobile onboarding is required before Freighter WalletConnect support is built;
- `@albedo-link/intent` ships a documented SEP-53 `sign_message` result and an
  Albedo `tx` intent is proven on testnet against an unfunded operation source.

## Alternatives considered

**Keep Albedo and build the SEP-53 adapter.** Viable on the evidence above, and
it covers mobile browsers. Rejected for Week 2 on cost: it doubles the signing
proof and the QA matrix, and it depends on an undocumented result field.

**Keep Albedo as connect-only.** Rejected. It is the worst of both options: a
wallet the UI offers, that cannot complete the flow.

**Replace Albedo with Freighter WalletConnect now.** That is the path that
actually closes the mobile gap. Rejected for Week 2 because it is new
integration work with its own session model, and nothing in the SOW's
acceptance criteria requires it. It is the natural follow-up if mobile becomes
a requirement.

## Amendment: Freighter Mobile over WalletConnect (2026-09-22)

The mobile gap this record accepted is closed. The owner ruling on D-4 (see below) makes
the mobile path Deliverable 3 scope.

**What shipped.** [PR #134](https://github.com/webnxt-2030/Centient/pull/134) added
Freighter Mobile over WalletConnect v2 (`lib/stellar/wallet-connect.ts`,
`components/FreighterPairing.tsx`). `lib/stellar/wallet.ts` now covers two transports: the
extension wherever it answers, otherwise WalletConnect when
`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is set. [PR #135](https://github.com/webnxt-2030/Centient/pull/135)
added the WalletConnect relay, registry and pulse to `connect-src`. Both are live on `web`
at staging `a4c8989`.

**Still Freighter only.** This adds a second *transport* for the same wallet, not a second
wallet. The decision above, and its Albedo reopen criteria, are unchanged. The second
reopen criterion ("mobile onboarding is required before Freighter WalletConnect support is
built") can no longer trigger.

**D-4 ruling.** The 2026-09-15 D-4 decision was due "before #35" and lapsed when #35 closed
on 2026-09-21 without it. It is decided now: **mobile through Freighter WalletConnect is in
scope for Deliverable 3, and is verified in the Epic 3 QA gate (#41)** against the acceptance
criteria in #137.

**Consequences.**

- **Desktop users without the extension no longer see "install the Freighter browser
  extension".** They get a "Scan with Freighter" QR modal instead. This is intended: a
  desktop user can pair their phone.
- **QA runs on production.** `web` builds the `staging` branch to centient.work, and there is
  no separate staging origin. This is acceptable because the deployment is testnet-only.
- **Network must match.** Freighter Mobile refuses a request whose CAIP chain differs from
  the wallet's network. The browser reads `NEXT_PUBLIC_STELLAR_NETWORK`, falling back to
  `STELLAR_NETWORK` and then `testnet`. Set the public variable explicitly before any mainnet
  build.
- **Known gap:** `connect()` has no timeout, and the pairing dialog has no cancel. A pairing
  the user abandons leaves the dialog open until the page is reloaded. Tracked in #138.
- **Rollback** is unsetting the project id and rebuilding `web`. There is no revert PR, no
  migration and no persisted state.

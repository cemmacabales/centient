# Freighter Wallet Signing Design

## Goal

Settle, on evidence from the real Freighter extension, how a contributor proves
they control a Stellar address and how they co-sign the sponsored onboarding
transaction. This closes the #24 (E2-1) spike and is the contract #25 and #26
build on.

Freighter is the only supported wallet (ADR-0003). Every claim below is backed
by the run recorded in
[`2026-09-14-freighter-wallet-signing-evidence.json`](2026-09-14-freighter-wallet-signing-evidence.json),
unless it is marked as coming from the stand-in script.

## The run

| | |
| --- | --- |
| When | 2026-09-14, 04:14–04:21Z |
| Network | testnet (`Test SDF Network ; September 2015`) |
| Wallet | Freighter browser extension, desktop Chrome. `@stellar/freighter-api` 6.0.1. The extension's own version was not captured |
| Account | `GD2IRAAPZE6WY2J6WOKEYZPIYKY4G7Z55MG5CUAF7QMQRHVGG7OM2YM4`, created in Freighter for this run and never funded (Horizon 404 before the run) |
| Harness | `/dev/freighter-proof`, behind `WALLET_PROOF_HARNESS=1`, testnet only |
| Sponsor | `GDDRUWSDRHUJ3GOBWDJCELSRI2PCOPBEBCUBR5K23PHABNCJWHNU53GH`, a friendbot-funded key created for the server process |

The evidence was read from the harness page's evidence panel, not copied with
the button, so it has no `generatedAt` stamp.

One entry needs explaining. The first `challenge.reject` (04:16:20Z) shows
`signedAnyway: true` because Approve was clicked by mistake. That signature was
never sent to the server, and its challenge expired unused. The step was run
again at 04:18:01Z and rejected properly. Both entries are kept.

## Ownership proof

### Challenge format

The server issues a challenge; the client never composes one.

```
Centient: prove you control this Stellar address.

Address: <G… address, exactly as the wallet returned it>
Network: <network passphrase>
Action: prove-stellar-address
Nonce: <32 hex chars, 16 random bytes>
Issued At: <ISO-8601>
Expires At: <Issued At + 5 minutes>
```

Each field binds the signature to one context:

- **Address.** Compared case-sensitively and never normalized. A lowercased
  address is refused as `invalid_address`.
- **Network.** The passphrase is inside the signed bytes, so a testnet proof
  cannot be presented on the public network.
- **Action.** A signature for this action cannot be reused for another message
  type that shares the prefix.
- **Nonce.** One challenge, one proof.
- **Issued At / Expires At.** `CHALLENGE_TTL_MS` is 5 minutes.

### Signing scheme

Freighter's `signMessage` signs per **SEP-53**: ed25519 over
`sha256("Stellar Signed Message:\n" ‖ message)`. It does not sign the raw
message bytes, and the second check below proves the server refuses a
raw-message signature.

**This Freighter returns V4**: `signedMessage` is a base64 string
(`rawSignatureType: "string (base64, V4)"`). `freighterSignatureToBase64` in
`lib/stellar/wallet.ts` still accepts the V3 `Buffer` shape. That branch is
not exercised by this run and stays only for older installs.

`signerAddress` came back equal to the connected address.

### One-time consumption

`ChallengeStore.verify` consumes the nonce on the **first attempt, whatever
its outcome**. A failed proof cannot be corrected and retried against the same
challenge; the client must request a new one. The real run confirmed a replay of
an accepted proof returns `401 replayed`.

The store is in memory and bounded (`b9d39d8`):

- at most `MAX_OUTSTANDING_CHALLENGES` (1000) issued challenges, evicting the
  oldest at the cap;
- expired challenges are dropped;
- a consumed nonce is remembered only until its challenge would have expired.

A replay after that fails as `unknown_nonce` instead of `replayed`. It is still
refused.

This store suits the harness. Production (#25) needs the nonce in the database,
because `web` can run more than one process and restarts lose memory.

### Negative verification rules: messages (7)

All passed against the real Freighter signature:

| # | Check | Expect |
| --- | --- | --- |
| 1 | Signature verifies over the issued challenge (SEP-53) | accept |
| 2 | Signature over the raw message, not the SEP-53 digest | reject |
| 3 | Same signature for a different nonce | reject |
| 4 | Same signature for the other network | reject |
| 5 | Same signature for a different address | reject |
| 6 | Bit-flipped signature | reject |
| 7 | Truncated signature | reject |

Beyond the signature itself, `verify` also refuses `invalid_address`,
`unknown_nonce`, `replayed`, `expired`, `wrong_address` and `wrong_signer`
(Freighter's `signerAddress` differs from the claimed address). The unit tests
cover each of these.

## Sponsored onboarding co-sign

### Envelope

The server builds and signs, as sponsor, one transaction whose operations are
exactly:

```
beginSponsoringFutureReserves (source: sponsor, sponsoredId: recipient)
createAccount                 (starting balance 0)          ← account+trustline only
changeTrust USDC              (source: recipient)
endSponsoringFutureReserves   (source: recipient)
```

The kind is `account+trustline` for an address that does not exist yet, and
`trustline` for an existing account without a USDC trustline. The recipient
co-signs in Freighter with `signTransaction`, and the server re-inspects the
returned envelope before it submits.

### Freighter signs for a never-funded account

**Yes.** Freighter signed both the SEP-53 message and the transaction for an
address that did not exist on the ledger. Neither signature needs the account
to exist. After submission the account exists, holding XLM 0 and USDC 0.

### Negative verification rules: envelopes (7)

All passed on the real Freighter co-signed envelope:

| # | Check | Expect |
| --- | --- | --- |
| 1 | Envelope is a plain transaction, not a fee bump | accept |
| 2 | Transaction bytes unchanged since the sponsor signed (hash matches) | accept |
| 3 | Operations are exactly the sponsored onboarding sandwich | accept |
| 4 | Sponsor signature still valid | accept |
| 5 | Recipient (Freighter) signature valid for this network | accept |
| 6 | Recipient signature does not verify under the other network's passphrase | reject |
| 7 | No signatures beyond sponsor and recipient | accept |

Check 2 is the one that matters most. Freighter hands back a whole envelope, so
the server must not trust anything but the bytes it signed itself.

### Fee bump

With the fee bump on, the server wraps the co-signed inner transaction in a fee
bump signed by the sponsor, who becomes the fee account. Verified on Horizon:

| | |
| --- | --- |
| Fee-bump tx | [`0c16eadd…72da1b`](https://stellar.expert/explorer/testnet/tx/0c16eadd6ea8f710371a3dfcf3f6935c632f2b46d12909c0709498095e72da1b), successful, 1 signature |
| Inner tx | `0ca34d58a22a5e1fa5428553b838c39055b281971c87b795363cc1de96602c89`, 2 signatures (sponsor, recipient), `max_fee` 400 |
| Fee account | the sponsor |
| Fee bump max | 1000 stroops; **charged 500** |
| Recipient after | XLM `0.0000000`, USDC `0.0000000` |
| Sponsors | account and USDC trustline both sponsored by the sponsor; `num_sponsored` 3 |

The recipient pays nothing and needs no XLM, before or after.

Freighter showed **Fee 0.00004 XLM** in its confirmation window. That is the
inner transaction's `max_fee` (4 ops × 100 stroops). The contributor does not
pay it, because the fee bump replaces the fee source. The UI will need to say
so, or a contributor with 0 XLM may reasonably refuse to confirm.

### What Freighter shows the contributor

The confirmation window summarises the transaction as **"USDC · Add
Trustline"**, plus wallet, network, fee and memo. `createAccount` and the
sponsorship operations appear only under *Transaction details*. The screen
Centient shows before calling Freighter has to explain the whole action ("we
create your account and add USDC, and we pay for both"), because Freighter's
summary will not.

## User rejection

Rejecting in Freighter returns an error and no signature. It does not throw.
The same shape came back for messages and transactions:

```json
{ "code": -4, "message": "The user rejected this request." }
```

The run recorded only `error`, not the other fields. `@stellar/freighter-api`
6.0.1 types `signTransaction`'s `signedTxXdr` as always present next to an
optional `error`, so nothing in the types marks a rejection except `error`.

Callers must check `error` before reading the signature or XDR.
`lib/stellar/wallet.ts` does, and wraps it as
`Freighter signing failed: <message>`. #25/#26 should match `code === -4` and
show a neutral "you cancelled" state, not a failure.

A rejection never reaches the server, so it uses nothing up:

- **Message.** The challenge stays outstanding until it expires or is evicted.
  The client should request a fresh one to retry, not reuse it.
- **Transaction.** The sponsor-signed envelope stays pending for that address.
  Building again replaces it, and a submit removes it only once the envelope
  passes inspection ("one submission per build"). The run rebuilt after the
  rejection anyway. Production (#26) should do the same: never re-offer an
  envelope the contributor has already declined.

## The Freighter adapter

`lib/stellar/wallet.ts` is the only production module that imports
`@stellar/freighter-api`, and it does so with dynamic `import()` in each call,
so the module is SSR-safe:

- `isFreighterAvailable()` wraps `isConnected()`.
- `connect()` wraps `requestAccess()` and validates the returned `G…` address.
  In this run the connect prompt did not appear, because localhost already had
  access; a first-time site gets a prompt.
- `signOwnership(message, expectedAddress)` wraps `signMessage`, requires
  `signerAddress === expectedAddress`, and normalizes V3/V4 to base64.
- `signTransaction(xdr, expectedAddress)` wraps `signTransaction` with the
  configured network passphrase and requires the signer to match.

The harness (`components/dev/FreighterProofHarness.tsx`) calls
`@stellar/freighter-api` directly so it can record raw return shapes. It is
spike tooling, not a second adapter.

## Mobile: the WalletConnect gap

This run covers **desktop Freighter only**. Freighter Mobile is reachable only
over WalletConnect v2 (`stellar_signMessage`, `stellar_signXDR`), and no Epic 2
issue builds a WalletConnect client (ADR-0003). Until one exists, a contributor
needs desktop Chrome with the Freighter extension to onboard. If the chapter
cohort is phone-first, the ≥ 25-wallet target (#49) depends on that work. Decide
before #35.

## Stand-in script, for comparison

Before the extension run, `output/e2-1-harness-e2e.mjs` drove the same API with
a local keypair that signs what Freighter signs. It produced the same outcomes:
accepted with 7/7 message rules, `replayed`, `bad_signature` for a forged
signature, a 400 for an unsigned submit, and a successful fee-bumped
`account+trustline` onboarding (`c0b27f8c…ac2425`). The extension run above
agrees with it on every point it covers, and adds the four facts only the real
wallet could supply:

- the signature shape;
- signing for an unfunded account;
- the rejection error;
- what the confirmation window shows.

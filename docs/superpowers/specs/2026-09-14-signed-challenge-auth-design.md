# Signed-Challenge Authentication Design

## Goal

Let a contributor sign in with a Stellar address they control, with no
email/password session, by signing a one-time server challenge in Freighter.
This is #25 (E2-2). It turns the ownership proof settled by the #24 spike
([`2026-09-14-freighter-wallet-signing-design.md`](2026-09-14-freighter-wallet-signing-design.md))
into production authentication. #26 builds the Freighter connect UI and the
passwordless session experience on top of it.

## Decisions

Settled with `cemmacabales` on 2026-09-14:

| Question | Decision |
| --- | --- |
| Which account does a proof resolve to? | **Find or create.** The `User` whose `walletAddress` equals the proven address, including an email account that linked it; otherwise a new wallet-only `User`. |
| Where do challenges live? | **The existing `wallet_nonces` table**, extended with an `action` column so sign-in and payout-link challenges cannot interfere. |
| When is a challenge consumed? | **On the first verification attempt, whatever its outcome**, as #24 decided. A failed proof cannot be retried against the same challenge. |

## Challenge format

Unchanged from #24. The server composes it; the client never does.

```
Centient: prove you control this Stellar address.

Address: <G… address, exactly as submitted>
Network: <network passphrase>
Action: prove-stellar-address
Nonce: <32 hex chars, 16 random bytes>
Issued At: <ISO-8601>
Expires At: <Issued At + 5 minutes>
```

The signature is SEP-53: ed25519 over
`sha256("Stellar Signed Message:\n" ‖ message)`, checked by the existing
`verify()` in `lib/stellar/signature.ts`.

`buildChallengeMessage`, `PROOF_ACTION` and `CHALLENGE_TTL_MS` move from
`lib/stellar/freighter-proof.ts` into `lib/stellar/challenge-message.ts`.
`lib/stellar/freighter-proof.ts` re-exports them, so the harness and
production cannot drift apart on the signed bytes.

## Storage

### Migration

`wallet_nonces` gains three columns:

| Column | Type | Default | Purpose |
| --- | --- | --- | --- |
| `action` | `TEXT NOT NULL` | `'link-payout-address'` | Which flow issued the challenge. Existing rows are payout-link challenges, so the default keeps them valid. |
| `networkPassphrase` | `TEXT NULL` | none | The passphrase bound at issue. Required for sign-in rows; the link flow does not set it. |
| `issuedAt` | `TIMESTAMP(3) NOT NULL` | `CURRENT_TIMESTAMP` | Rebuilds the exact signed message. |

It also adds a unique constraint on `(walletAddress, action)`, after removing
older duplicate rows from populated databases. The existing unique index on
`nonce` stays.

### Issuing

`issueSignInChallenge(address, now)`:

1. Deletes every expired row, of either action.
2. Inserts a row with `action`, `networkPassphrase` (the server's current one),
   `nonce`, `issuedAt` and `expiresAt`.
3. If another live challenge for the same address/action wins the unique-index
   race, reads and returns that committed row instead.

It returns `{ nonce, message, expiresAt }`. Sequential and concurrent issuers
therefore reuse one live challenge rather than invalidating a response another
caller may already be signing.

### Verifying

`consumeSignInChallenge({ address, nonce, signature, signerAddress, now })`
returns `{ ok: true, address }` or `{ ok: false, reason }`.

1. **Claim.** One statement,
   `prisma.walletNonce.delete({ where: { nonce, action: 'prove-stellar-address' } })`.
   A missing row (Prisma `P2025`) is `challenge_not_found`. This single delete is
   the only thing that grants access, so two concurrent attempts with the same
   nonce cannot both succeed. It also consumes the challenge before any other
   check runs.
2. **Rebuild.** The message is rebuilt from the stored row, never from
   client-supplied fields.
3. **Check, in order,** stopping at the first failure:

| # | Check | Reason on failure |
| --- | --- | --- |
| 1 | `now` is strictly before the row's `expiresAt` | `challenge_expired` |
| 2 | The row's `walletAddress` equals `address`, compared exactly, never normalized | `wrong_address` |
| 3 | The row's `networkPassphrase` equals the server's current passphrase | `wrong_network` |
| 4 | `signerAddress`, when sent, equals `address` | `wrong_signer` |
| 5 | `verify(address, message, signature)` | `bad_signature` |

A replayed proof finds no row and fails at the claim as `challenge_not_found`.
Unlike the #24 harness there is no separate `replayed` code, because a consumed
row is gone rather than remembered. It is refused either way.

### Payout-link flow

`/api/me/wallet` is Deliverable 1 code that passed QA, so its message format,
verifier and responses do not change. Its nonce queries gain
`action: 'link-payout-address'`, so the two flows stay isolated. Issuance also
uses the shared `(walletAddress, action)` uniqueness rule: it reuses a live
link challenge after P2002, or retries if the conflicting row expired before
it could be read. Verification conditionally consumes only the exact nonce it
verified while that row is still unexpired, so it cannot consume a replacement.

## Routes

Both routes are public (no session required) and live under `app/api/auth/wallet/`.

### `POST /api/auth/wallet/challenge`

Request `{ address }`. POST, because it writes a row.

| Outcome | Status | Body |
| --- | --- | --- |
| Issued | 200 | `{ nonce, message, expiresAt }` |
| Body not JSON, or `address` missing or not a valid `G…` key (a lowercased key is invalid) | 400 | `{ error: "invalid_address" }` |
| Rate-limited | 429 | `{ error: "rate_limited" }` |

Two throttles, both on `checkWalletRateLimit`:

- `auth-challenge:<address>`, which bounds churn on one address;
- `auth-challenge-ip:<x-real-ip>`, which bounds a caller looping fresh
  addresses. It keys on `x-real-ip` for the reason `app/api/auth/login` gives:
  the first `x-forwarded-for` entry is client-controlled.

Each issue also prunes expired rows, so the table stays proportional to live
challenges.

### `POST /api/auth/wallet/verify`

Request `{ address, nonce, signature, signerAddress? }`.

| Outcome | Status | Body |
| --- | --- | --- |
| Signed in | 200 | `{ success: true, userId, walletAddress, created }`, and the `labeler_session` cookie is set |
| Body not JSON, `address` invalid, or `nonce` / `signature` missing or not strings | 400 | `{ error: "invalid_body" }` or `{ error: "invalid_address" }` |
| Any consume failure | 401 | `{ error: <reason> }` |

A 400 is returned before the claim, so it does not consume the challenge. Every
401 does.

A malformed signature (bad base64, truncated, wrong length) is not a 400. It
reaches `verify()`, which returns false, so it is `bad_signature`, and the
challenge is consumed.

### Identity resolution

After a successful consume:

1. `prisma.user.upsert({ where: { walletAddress }, update: {}, create: { walletAddress } })`.
2. If that throws `P2002` (a concurrent first sign-in created the row between
   upsert's read and write), re-read with `findUnique({ where: { walletAddress } })`.

`walletAddress` is already `@unique`, so one address can never become two
contributor identities. `created` in the response is true only when this request
created the row.

The session is the existing userId-keyed `labeler_session` JWT from
`lib/labeler-auth.ts` (`signLabelerJWT`, `setLabelerSessionCookie`). A request
that already carries a session is signed in as the proven address's user, and
the cookie is replaced.

### Deliberately unchanged

- **Bans are not checked at sign-in.** Email login does not check them either;
  they are enforced where they matter, at `/api/submit`.
- **Linking is still `/api/me/wallet`.** A contributor signed in by email who
  proves an address they never linked gets a separate wallet-only account. The
  proof does not attach the address to the current session's account.
- **Email/password login and registration are untouched.**

## Testing

### Route tests

These follow `app/api/me/wallet/__tests__/route.test.ts`: Prisma, the session
helpers and the rate limiter are mocked; `Keypair`, StrKey and SEP-53 signing
are real.

Challenge route:

- valid address issues a challenge whose message matches the #24 format;
- lowercased, non-StrKey and missing addresses → 400;
- each throttle → 429.

Verify route, where a valid proof issues **exactly one** session cookie, and
each of these is rejected with its reason and no cookie:

| Case | Expect |
| --- | --- |
| Expired challenge | `challenge_expired` |
| Replay: the same proof submitted a second time | `challenge_not_found` |
| Unknown nonce | `challenge_not_found` |
| Row issued for a different address | `wrong_address` |
| Lowercased address | 400 `invalid_address` |
| Row issued under the other network's passphrase | `wrong_network` |
| `signerAddress` differs from `address` | `wrong_signer` |
| Signature by a different key | `bad_signature` |
| Signature over the raw message, not the SEP-53 digest | `bad_signature` |
| Bit-flipped, truncated or non-base64 signature | `bad_signature` |
| Non-JSON body; missing `nonce` or `signature` | 400 |

Identity:

- an existing wallet-only user signs in as itself, `created: false`;
- an email user who linked the address signs in as that user;
- an unknown address creates one wallet-only user, `created: true`;
- `P2002` on the upsert resolves to the existing user, not a 500.

Link-flow regression:

- `/api/me/wallet` GET and POST are scoped to `action: 'link-payout-address'`;
  its existing tests still pass.

### Module tests

`lib/stellar/auth-challenge.ts`: check ordering (an expired row for the wrong
address reports `challenge_expired`), consumption happens before the checks, and
the rebuilt message uses the stored `issuedAt` and `networkPassphrase`.

### Real-database test

In the suite that runs `lib/__tests__/payout-concurrency-db.test.ts`: two
concurrent verifies with the same valid proof yield exactly one 200 and one
`challenge_not_found`. This is the property the mocked tests cannot prove.

## Out of scope

- All UI, including the Freighter connect button and handling its
  `code: -4` "user rejected" result. That is #26.
- Moving `/api/me/wallet` onto this challenge format and verifier.
- WalletConnect / Freighter Mobile (ADR-0003).
- Session revocation or rotation beyond the existing 7-day JWT.

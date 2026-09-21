# Signed-Challenge Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a contributor sign in with a Stellar address they control, with no email/password session, by signing a one-time server challenge. This is issue #25 (E2-2).

**Architecture:** Challenges move from the #24 harness's process memory into the existing `wallet_nonces` table, tagged by `action` so sign-in and payout-link challenges cannot touch each other. A new `lib/stellar/auth-challenge.ts` issues challenges and consumes them with a single `delete`, which is both the one-time consumption and the concurrency guard. Two public routes sit on top: `POST /api/auth/wallet/challenge` and `POST /api/auth/wallet/verify`. A successful proof resolves to the `User` holding the address, creating a wallet-only one if none exists, and sets the existing `labeler_session` cookie.

**Tech Stack:** Next.js route handlers (`NextRequest` / `NextResponse`), Prisma 7 with `@prisma/adapter-pg` on Postgres, `@stellar/stellar-sdk` (SEP-53 via `lib/stellar/signature.ts`), `jose` sessions via `lib/labeler-auth.ts`, Vitest against a real test database.

**Spec:** [`docs/superpowers/specs/2026-09-14-signed-challenge-auth-design.md`](../specs/2026-09-14-signed-challenge-auth-design.md). It builds on [`2026-09-14-freighter-wallet-signing-design.md`](../specs/2026-09-14-freighter-wallet-signing-design.md).

## Global Constraints

- **Signed bytes.** The challenge message is byte-identical to #24's format: the lines `Centient: prove you control this Stellar address.`, a blank line, then `Address:`, `Network:`, `Action: prove-stellar-address`, `Nonce:`, `Issued At:`, `Expires At:`.
- **Lifetimes.** `CHALLENGE_TTL_MS` is `5 * 60 * 1000`. The nonce is `randomBytes(16).toString("hex")` (32 hex chars).
- **Action strings, exactly:** sign-in `"prove-stellar-address"`, payout link `"link-payout-address"`.
- **Addresses** are compared case-sensitively and never lowercased, trimmed, or otherwise normalized.
- **Consumption.** A challenge is consumed on the first verification attempt, whatever its outcome. The claim is one `prisma.walletNonce.delete({ where: { nonce, action } })`.
- **Check order after the claim:** expiry → address → network → signer → signature.
- **Rejection codes, exactly:** `challenge_not_found`, `challenge_expired`, `wrong_address`, `wrong_network`, `wrong_signer`, `bad_signature` (all 401). The 400s are `invalid_body` and `invalid_address`, and a 400 never consumes a challenge.
- **Sessions** use the existing `signLabelerJWT` + `setLabelerSessionCookie` from `lib/labeler-auth.ts`. No new cookie or JWT shape.
- **`/api/me/wallet`** scopes queries to `action: "link-payout-address"` and reuses the live row selected by the `(walletAddress, action)` constraint. Its message, verifier and responses are untouched.
- **Out of scope:** any UI, Freighter `code: -4` handling (#26), moving the link flow onto this format, WalletConnect.
- **Next.js.** This repo's Next.js differs from older versions. Before writing route code, read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`. The handlers here use only `POST(req: NextRequest)` and `NextResponse.json`, matching `app/api/auth/login/route.ts`.
- **Commits.** Author `cemmacabales <carlmacabales31@gmail.com>` only. **No trailers of any kind** (no `Co-Authored-By`, no generated-by lines); CI's `verify-commit-identities` and `single-contributor/verified` checks enforce this. Commits are atomic: each leaves the branch valid.
- **Branch:** `feat/issue-25-signed-challenge-auth` in `.worktrees/issue-25-signed-challenge-auth`, cut from `develop` at `34d5094`. The PR targets `develop`, and only `cemmacabales` merges.

## Where this plan refines the spec

Three implementation choices the spec left open or stated loosely. None changes behaviour the spec describes.

1. **The message format lives in its own pure module, `lib/stellar/challenge-message.ts`, not in `auth-challenge.ts`.** `lib/prisma.ts` constructs a `PrismaClient` at import time. If the harness imported the format from `auth-challenge.ts`, the testnet harness would load Prisma for no reason. `auth-challenge.ts` imports from it too.
2. **Identity resolution is find → create → re-read on `P2002`, not `upsert`.** Prisma can run an `upsert` as a native `INSERT … ON CONFLICT`, which never reports whether it created the row, so the response's `created` flag could not be derived. The race handling the spec requires is unchanged.
3. **The new tests run against the real test database, not mocked Prisma.** The properties under test are the atomic delete and the unique index, and mocks cannot prove either. This is the pattern `app/api/auth/login/__tests__/route.test.ts` already uses. Only `@/lib/rate-limit` is mocked. The existing mocked `/api/me/wallet` tests stay mocked.
4. **Post-review issuance uses database uniqueness and challenge reuse.** `WalletNonce` has a unique `(walletAddress, action)` constraint. Concurrent issuers reuse the committed live row after P2002; if it expired or was consumed before the reread, issuance retries. A sign-in challenge from another network is replaced.

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `lib/stellar/challenge-message.ts` | Create | The pure signed-message format and the action and TTL constants |
| `lib/stellar/__tests__/challenge-message.test.ts` | Create | Pins the exact signed bytes; proves the harness shares them |
| `lib/stellar/freighter-proof.ts` | Modify | Imports and re-exports the format instead of defining it |
| `prisma/schema.prisma` | Modify | `WalletNonce` gains `action`, `networkPassphrase`, `issuedAt`, and a unique wallet/action constraint |
| `prisma/migrations/20260914120000_add_wallet_nonce_action/migration.sql` | Create | Adds the fields, deduplicates existing rows, and installs the constraint atomically |
| `app/api/me/wallet/route.ts` | Modify | Scopes link-flow queries and reuses the committed challenge after P2002 |
| `app/api/me/wallet/__tests__/route.test.ts` | Modify | Asserts the scoping |
| `lib/stellar/auth-challenge.ts` | Create | `issueSignInChallenge`, `consumeSignInChallenge`, `findOrCreateWalletUser` |
| `lib/stellar/__tests__/auth-challenge.test.ts` | Create | Module tests against the real database |
| `app/api/auth/wallet/challenge/route.ts` | Create | Public challenge issuance with throttles |
| `app/api/auth/wallet/challenge/__tests__/route.test.ts` | Create | Route tests |
| `app/api/auth/wallet/verify/route.ts` | Create | Public proof verification, identity resolution, session |
| `app/api/auth/wallet/verify/__tests__/route.test.ts` | Create | Route tests, including the concurrent-replay case |

`lib/stellar/__tests__/*.test.ts` files join the payments lane automatically through `tests/payments-lane.ts`'s glob. That is harmless: the lane has its own Postgres service, and nothing here submits to Horizon, builds a payment, or reads a signer secret, so the no-single-key guard has nothing to flag.

---

### Task 1: Extract the challenge message format

**Files:**
- Create: `lib/stellar/challenge-message.ts`
- Create: `lib/stellar/__tests__/challenge-message.test.ts`
- Modify: `lib/stellar/freighter-proof.ts` (the `CHALLENGE_TTL_MS` … `buildChallengeMessage` block, currently right after the `// Ownership proof` banner)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `CHALLENGE_TTL_MS: number` (`300000`)
  - `PROOF_ACTION: "prove-stellar-address"`
  - `WALLET_LINK_ACTION: "link-payout-address"`
  - `interface ChallengeFields { address: string; networkPassphrase: string; nonce: string; issuedAt: Date; expiresAt: Date }`
  - `buildChallengeMessage(fields: ChallengeFields): string`
  - `lib/stellar/freighter-proof.ts` keeps exporting `CHALLENGE_TTL_MS`, `PROOF_ACTION`, `buildChallengeMessage` and `ChallengeFields`, so its existing test and route do not change.

- [ ] **Step 1: Install dependencies and generate the client in the worktree**

The worktree has no `node_modules`. CI installs with `npm ci` from the committed `package-lock.json`, so do the same.

Run:
```bash
npm ci
npx prisma generate
```
Expected: both finish without errors. `app/generated/prisma` now exists and is git-ignored (`git status --short` shows nothing new).

- [ ] **Step 2: Write the failing test**

Create `lib/stellar/__tests__/challenge-message.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import {
  CHALLENGE_TTL_MS,
  PROOF_ACTION,
  WALLET_LINK_ACTION,
  buildChallengeMessage,
} from "@/lib/stellar/challenge-message";
import * as harness from "@/lib/stellar/freighter-proof";

describe("buildChallengeMessage", () => {
  it("produces exactly the bytes #24 proved Freighter signs", () => {
    const address = Keypair.random().publicKey();
    const message = buildChallengeMessage({
      address,
      networkPassphrase: Networks.TESTNET,
      nonce: "00112233445566778899aabbccddeeff",
      issuedAt: new Date("2026-09-14T04:16:00.000Z"),
      expiresAt: new Date("2026-09-14T04:21:00.000Z"),
    });

    expect(message).toBe(
      [
        "Centient: prove you control this Stellar address.",
        "",
        `Address: ${address}`,
        "Network: Test SDF Network ; September 2015",
        "Action: prove-stellar-address",
        "Nonce: 00112233445566778899aabbccddeeff",
        "Issued At: 2026-09-14T04:16:00.000Z",
        "Expires At: 2026-09-14T04:21:00.000Z",
      ].join("\n"),
    );
  });

  it("never normalizes the address", () => {
    const address = Keypair.random().publicKey();
    const message = buildChallengeMessage({
      address: address.toLowerCase(),
      networkPassphrase: Networks.TESTNET,
      nonce: "ab",
      issuedAt: new Date(0),
      expiresAt: new Date(CHALLENGE_TTL_MS),
    });
    expect(message).toContain(`Address: ${address.toLowerCase()}`);
    expect(message).not.toContain(address);
  });
});

describe("constants", () => {
  it("pins the lifetime and both action strings", () => {
    expect(CHALLENGE_TTL_MS).toBe(5 * 60 * 1000);
    expect(PROOF_ACTION).toBe("prove-stellar-address");
    expect(WALLET_LINK_ACTION).toBe("link-payout-address");
  });
});

describe("the #24 harness", () => {
  it("shares the production format rather than keeping its own copy", () => {
    expect(harness.buildChallengeMessage).toBe(buildChallengeMessage);
    expect(harness.CHALLENGE_TTL_MS).toBe(CHALLENGE_TTL_MS);
    expect(harness.PROOF_ACTION).toBe(PROOF_ACTION);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run lib/stellar/__tests__/challenge-message.test.ts`
Expected: FAIL. The import of `@/lib/stellar/challenge-message` cannot be resolved.

- [ ] **Step 4: Create the module**

Create `lib/stellar/challenge-message.ts`:

```ts
// The text a contributor signs to prove they control a Stellar address.
//
// #24 settled this format against the real Freighter extension; #25 signs
// contributors in with it. Pure on purpose — no database, no network — so the
// testnet proof harness can share the exact signed bytes without loading
// Prisma, and so the two can never drift apart.

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * The `Action:` line of a sign-in proof, and the `wallet_nonces.action` value
 * its challenge row carries.
 */
export const PROOF_ACTION = "prove-stellar-address";

/**
 * `wallet_nonces.action` for the Deliverable 1 payout-address link flow
 * (`/api/me/wallet`). That flow signs its own, older message; the value exists
 * only so the two flows' queries cannot reach each other's rows.
 */
export const WALLET_LINK_ACTION = "link-payout-address";

export interface ChallengeFields {
  address: string;
  networkPassphrase: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}

/**
 * The exact text Freighter signs. SEP-53 has no network or domain field of its
 * own, so every binding the verifier relies on has to live in the message.
 */
export function buildChallengeMessage(fields: ChallengeFields): string {
  return [
    "Centient: prove you control this Stellar address.",
    "",
    `Address: ${fields.address}`,
    `Network: ${fields.networkPassphrase}`,
    `Action: ${PROOF_ACTION}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt.toISOString()}`,
    `Expires At: ${fields.expiresAt.toISOString()}`,
  ].join("\n");
}
```

- [ ] **Step 5: Point the harness at it**

In `lib/stellar/freighter-proof.ts`, add this import after the existing `import { isValidStellarAddress, verify } from "./signature";` line:

```ts
import { CHALLENGE_TTL_MS, buildChallengeMessage, type ChallengeFields } from "./challenge-message";
```

Then replace this whole block, from `export const CHALLENGE_TTL_MS` through the closing `}` of `buildChallengeMessage`:

```ts
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const PROOF_ACTION = "prove-stellar-address";

export interface ChallengeFields {
  address: string;
  networkPassphrase: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface IssuedChallenge extends ChallengeFields {
  message: string;
}

/**
 * The exact text Freighter signs. SEP-53 has no network or domain field of its
 * own, so every binding the verifier relies on has to live in the message.
 */
export function buildChallengeMessage(fields: ChallengeFields): string {
  return [
    "Centient: prove you control this Stellar address.",
    "",
    `Address: ${fields.address}`,
    `Network: ${fields.networkPassphrase}`,
    `Action: ${PROOF_ACTION}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt.toISOString()}`,
    `Expires At: ${fields.expiresAt.toISOString()}`,
  ].join("\n");
}
```

with:

```ts
// The signed format is shared with production sign-in (#25); see
// challenge-message.ts. Re-exported so harness callers keep one import.
export {
  CHALLENGE_TTL_MS,
  PROOF_ACTION,
  buildChallengeMessage,
  type ChallengeFields,
} from "./challenge-message";

export interface IssuedChallenge extends ChallengeFields {
  message: string;
}
```

- [ ] **Step 6: Run the new and existing harness tests**

Run: `npx vitest run lib/stellar/__tests__/challenge-message.test.ts lib/stellar/__tests__/freighter-proof.test.ts`
Expected: PASS, both files.

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add lib/stellar/challenge-message.ts lib/stellar/__tests__/challenge-message.test.ts lib/stellar/freighter-proof.ts
git commit -m "refactor(wallet): share the ownership-proof message format with production sign-in"
```

---

### Task 2: Tag challenge rows by action

**Files:**
- Modify: `prisma/schema.prisma` (`model WalletNonce`)
- Create: `prisma/migrations/20260914120000_add_wallet_nonce_action/migration.sql`
- Modify: `app/api/me/wallet/route.ts`
- Modify: `app/api/me/wallet/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `WALLET_LINK_ACTION` from Task 1.
- Produces:
  - the `WalletNonce` fields `action: string` (default `"link-payout-address"`), `networkPassphrase: string | null` and `issuedAt: Date` (default now), in the generated client;
  - the unique constraint `wallet_nonces_walletAddress_action_key`.

- [ ] **Step 1: Change the schema**

In `prisma/schema.prisma`, replace:

```prisma
model WalletNonce {
  id            String    @id @default(uuid())
  walletAddress String
  nonce         String    @unique
  expiresAt     DateTime
  createdAt     DateTime  @default(now())

  @@index([walletAddress])
  @@index([expiresAt])
  @@map("wallet_nonces")
}
```

with:

```prisma
model WalletNonce {
  id                String   @id @default(uuid())
  walletAddress     String
  nonce             String   @unique
  // Which flow issued the challenge: "link-payout-address" (/api/me/wallet) or
  // "prove-stellar-address" (wallet sign-in, #25). Every query is scoped by it,
  // so neither flow can delete or satisfy the other's challenges.
  action            String   @default("link-payout-address")
  // Bound at issue for sign-in challenges; the link flow leaves it null.
  networkPassphrase String?
  issuedAt          DateTime @default(now())
  expiresAt         DateTime
  createdAt         DateTime @default(now())

  @@index([walletAddress])
  @@unique([walletAddress, action])
  @@index([expiresAt])
  @@map("wallet_nonces")
}
```

- [ ] **Step 2: Write the migration**

Create `prisma/migrations/20260914120000_add_wallet_nonce_action/migration.sql`:

```sql
-- Wallet sign-in (#25) shares wallet_nonces with the payout-address link flow.
--
-- `action` separates the two. Existing rows are all link challenges, so the
-- default keeps every outstanding one valid through the deploy.
-- `networkPassphrase` and `issuedAt` let the verifier rebuild a sign-in
-- challenge's exact signed text from the row alone, never from anything the
-- client sends back.
ALTER TABLE "wallet_nonces"
    ADD COLUMN "action" TEXT NOT NULL DEFAULT 'link-payout-address',
    ADD COLUMN "networkPassphrase" TEXT,
    ADD COLUMN "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- The final migration wraps column creation, deduplication, and this index in
-- one explicit transaction so legacy writers cannot insert between the steps.
CREATE UNIQUE INDEX "wallet_nonces_walletAddress_action_key" ON "wallet_nonces"("walletAddress", "action");
```

- [ ] **Step 3: Prove the migration matches the schema on a fresh database**

CI applies migrations with `prisma migrate deploy`, while the local test database is built with `db push`. Check the SQL itself, on a throwaway database:

```bash
psql postgresql://postgres:postgres@localhost:5433/postgres -c 'DROP DATABASE IF EXISTS centient_migrate_check' -c 'CREATE DATABASE centient_migrate_check'
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/centient_migrate_check npx prisma migrate deploy
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/centient_migrate_check npx prisma db push
```

Expected:
- `migrate deploy` applies every migration, ending with `20260914120000_add_wallet_nonce_action`.
- `db push` reports the database is already in sync with the Prisma schema.

If `db push` proposes changes, re-run the same three commands on a checkout of `develop` at `34d5094`. Any change that also appears there is pre-existing drift and not this task's. Any change touching `wallet_nonces` means the SQL above is wrong: fix it, and re-run.

Then drop the check database:

```bash
psql postgresql://postgres:postgres@localhost:5433/postgres -c 'DROP DATABASE centient_migrate_check'
```

- [ ] **Step 4: Update the local test database and client**

```bash
npx prisma generate
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/centient_test npx prisma db push --accept-data-loss
```

Expected: the client regenerates, and `centient_test` gains the three columns.

- [ ] **Step 5: Commit the schema change**

```bash
git add prisma/schema.prisma prisma/migrations/20260914120000_add_wallet_nonce_action/migration.sql
git commit -m "feat(db): tag wallet challenges by action and bind sign-in rows to a network"
```

- [ ] **Step 6: Write the failing link-route assertions**

In `app/api/me/wallet/__tests__/route.test.ts`, make three changes.

In `describe("GET /api/me/wallet (challenge)")`, replace the body of the test `"issues a signable challenge bound to the address + a fresh nonce"` with:

```ts
    const res = await GET(getReq(G));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain(G);
    expect(body.message).toContain(body.nonce);
    // Scoped to the link flow, so a pending wallet sign-in challenge for the
    // same address survives.
    expect(mockNonceDeleteMany).toHaveBeenCalledWith({
      where: { walletAddress: G, action: "link-payout-address" },
    });
    expect(mockNonceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ walletAddress: G, action: "link-payout-address" }),
      }),
    );
```

In `describe("POST /api/me/wallet (link + prove)")`, in the test `"links the address on a valid proof + trustline, consuming the nonce"`, replace:

```ts
    expect(mockNonceDeleteMany).toHaveBeenCalledWith({ where: { walletAddress: G } });
```

with:

```ts
    expect(mockNonceDeleteMany).toHaveBeenCalledWith({
      where: { walletAddress: G, action: "link-payout-address" },
    });
    // A sign-in challenge row can never be used to link an address.
    expect(mockNonceFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ walletAddress: G, action: "link-payout-address" }),
      }),
    );
```

- [ ] **Step 7: Run to verify they fail**

Run: `npx vitest run app/api/me/wallet/__tests__/route.test.ts`
Expected: FAIL in the two edited tests. The calls were made without `action`.

- [ ] **Step 8: Scope the link route**

In `app/api/me/wallet/route.ts`, add after the `import { checkWalletRateLimit } from "@/lib/rate-limit";` line:

```ts
import { WALLET_LINK_ACTION } from "@/lib/stellar/challenge-message";
```

In `GET`, replace:

```ts
  await prisma.$transaction([
    prisma.walletNonce.deleteMany({ where: { walletAddress: address } }),
    prisma.walletNonce.create({ data: { walletAddress: address, nonce, expiresAt } }),
  ]);
```

with:

```ts
  // Scoped to this flow: the same address may hold a pending wallet sign-in
  // challenge (#25), which a link request must not delete.
  await prisma.$transaction([
    prisma.walletNonce.deleteMany({ where: { walletAddress: address, action: WALLET_LINK_ACTION } }),
    prisma.walletNonce.create({
      data: { walletAddress: address, action: WALLET_LINK_ACTION, nonce, expiresAt },
    }),
  ]);
```

In `POST`, replace:

```ts
  const nonceRow = await prisma.walletNonce.findFirst({
    where: { walletAddress: stellarAddress, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
```

with:

```ts
  const nonceRow = await prisma.walletNonce.findFirst({
    where: { walletAddress: stellarAddress, action: WALLET_LINK_ACTION, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
```

and replace:

```ts
  await prisma.walletNonce.deleteMany({ where: { walletAddress: stellarAddress } });
```

with:

```ts
  await prisma.walletNonce.deleteMany({
    where: { walletAddress: stellarAddress, action: WALLET_LINK_ACTION },
  });
```

- [ ] **Step 9: Run the link route tests and typecheck**

Run: `npx vitest run app/api/me/wallet/__tests__/route.test.ts`
Expected: PASS, every test.

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 10: Commit**

```bash
git add app/api/me/wallet/route.ts app/api/me/wallet/__tests__/route.test.ts
git commit -m "fix(wallet): scope payout-link challenges so they cannot touch sign-in challenges"
```

---

### Task 3: Issue and consume sign-in challenges

**Files:**
- Create: `lib/stellar/auth-challenge.ts`
- Create: `lib/stellar/__tests__/auth-challenge.test.ts`

**Interfaces:**
- Consumes:
  - from Task 1: `CHALLENGE_TTL_MS`, `PROOF_ACTION`, `WALLET_LINK_ACTION`, `buildChallengeMessage`;
  - from Task 2: the `WalletNonce` columns;
  - existing: `networkPassphrase()` from `lib/stellar/config.ts`, and `isValidStellarAddress` and `verify` from `lib/stellar/signature.ts`.
- Produces:
  - `interface IssuedSignInChallenge { nonce: string; message: string; expiresAt: Date }`
  - `issueSignInChallenge(address: string, now?: Date): Promise<IssuedSignInChallenge>`, which throws on an invalid address
  - `type SignInRejection = "challenge_not_found" | "challenge_expired" | "wrong_address" | "wrong_network" | "wrong_signer" | "bad_signature"`
  - `type SignInProofResult = { ok: true; address: string } | { ok: false; reason: SignInRejection }`
  - `consumeSignInChallenge(input: { address: string; nonce: string; signature: string; signerAddress?: string; now?: Date }): Promise<SignInProofResult>`

- [ ] **Step 1: Write the failing tests**

Create `lib/stellar/__tests__/auth-challenge.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { sep53Digest } from "@/lib/stellar/signature";
import {
  CHALLENGE_TTL_MS,
  PROOF_ACTION,
  WALLET_LINK_ACTION,
  buildChallengeMessage,
} from "@/lib/stellar/challenge-message";
import {
  consumeSignInChallenge,
  issueSignInChallenge,
} from "@/lib/stellar/auth-challenge";

// Real database: the one-time delete and the action scoping are the properties
// under test, and a mocked Prisma cannot prove either.

const ORIGINAL_NETWORK = process.env.STELLAR_NETWORK;

beforeEach(async () => {
  process.env.STELLAR_NETWORK = "testnet";
  await truncateAll();
});

afterEach(() => {
  if (ORIGINAL_NETWORK === undefined) delete process.env.STELLAR_NETWORK;
  else process.env.STELLAR_NETWORK = ORIGINAL_NETWORK;
});

/** Sign exactly what Freighter's SEP-53 `signMessage` signs. */
const sign = (keypair: Keypair, message: string) =>
  keypair.sign(sep53Digest(message)).toString("base64");

const signInRows = (walletAddress: string) =>
  prisma.walletNonce.count({ where: { walletAddress, action: PROOF_ACTION } });

async function seedLinkChallenge(walletAddress: string, expiresAt: Date) {
  return prisma.walletNonce.create({
    data: {
      walletAddress,
      action: WALLET_LINK_ACTION,
      nonce: `link-${Keypair.random().publicKey().slice(1, 20)}`,
      expiresAt,
    },
  });
}

describe("issueSignInChallenge", () => {
  it("issues the #24 message and stores everything needed to rebuild it", async () => {
    const kp = Keypair.random();
    const now = new Date("2026-09-14T06:00:00.000Z");

    const challenge = await issueSignInChallenge(kp.publicKey(), now);

    expect(challenge.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(challenge.expiresAt.getTime()).toBe(now.getTime() + CHALLENGE_TTL_MS);
    expect(challenge.message).toBe(
      buildChallengeMessage({
        address: kp.publicKey(),
        networkPassphrase: Networks.TESTNET,
        nonce: challenge.nonce,
        issuedAt: now,
        expiresAt: challenge.expiresAt,
      }),
    );

    const row = await prisma.walletNonce.findUniqueOrThrow({ where: { nonce: challenge.nonce } });
    expect(row).toMatchObject({
      walletAddress: kp.publicKey(),
      action: PROOF_ACTION,
      networkPassphrase: Networks.TESTNET,
      issuedAt: now,
      expiresAt: challenge.expiresAt,
    });
  });

  it("keeps one outstanding sign-in challenge per address", async () => {
    const address = Keypair.random().publicKey();
    const first = await issueSignInChallenge(address);
    const second = await issueSignInChallenge(address);

    expect(await signInRows(address)).toBe(1);
    expect(await prisma.walletNonce.findUnique({ where: { nonce: first.nonce } })).toBeNull();
    expect(await prisma.walletNonce.findUnique({ where: { nonce: second.nonce } })).not.toBeNull();
  });

  it("leaves the same address's pending payout-link challenge alone", async () => {
    const address = Keypair.random().publicKey();
    const link = await seedLinkChallenge(address, new Date(Date.now() + CHALLENGE_TTL_MS));

    await issueSignInChallenge(address);

    expect(await prisma.walletNonce.findUnique({ where: { id: link.id } })).not.toBeNull();
  });

  it("prunes expired challenges of either action", async () => {
    const stale = await seedLinkChallenge(Keypair.random().publicKey(), new Date(Date.now() - 1000));

    await issueSignInChallenge(Keypair.random().publicKey());

    expect(await prisma.walletNonce.findUnique({ where: { id: stale.id } })).toBeNull();
  });

  it("refuses an address that is not a valid G… key, including a lowercased one", async () => {
    const address = Keypair.random().publicKey();
    await expect(issueSignInChallenge(address.toLowerCase())).rejects.toThrow();
    await expect(issueSignInChallenge("0xdeadbeef")).rejects.toThrow();
    expect(await prisma.walletNonce.count()).toBe(0);
  });
});

describe("consumeSignInChallenge", () => {
  async function issued(kp = Keypair.random(), now = new Date()) {
    const challenge = await issueSignInChallenge(kp.publicKey(), now);
    return { kp, address: kp.publicKey(), now, ...challenge };
  }

  it("accepts a valid proof and consumes the challenge", async () => {
    const c = await issued();
    const result = await consumeSignInChallenge({
      address: c.address,
      nonce: c.nonce,
      signature: sign(c.kp, c.message),
      signerAddress: c.address,
    });

    expect(result).toEqual({ ok: true, address: c.address });
    expect(await signInRows(c.address)).toBe(0);
  });

  it("refuses a replay of an accepted proof", async () => {
    const c = await issued();
    const proof = { address: c.address, nonce: c.nonce, signature: sign(c.kp, c.message) };

    expect((await consumeSignInChallenge(proof)).ok).toBe(true);
    expect(await consumeSignInChallenge(proof)).toEqual({ ok: false, reason: "challenge_not_found" });
  });

  it("refuses an unknown nonce", async () => {
    const c = await issued();
    const result = await consumeSignInChallenge({
      address: c.address,
      nonce: "f".repeat(32),
      signature: sign(c.kp, c.message),
    });
    expect(result).toEqual({ ok: false, reason: "challenge_not_found" });
  });

  it("cannot consume a payout-link challenge, and leaves it in place", async () => {
    const kp = Keypair.random();
    const link = await seedLinkChallenge(kp.publicKey(), new Date(Date.now() + CHALLENGE_TTL_MS));

    const result = await consumeSignInChallenge({
      address: kp.publicKey(),
      nonce: link.nonce,
      signature: sign(kp, "anything"),
    });

    expect(result).toEqual({ ok: false, reason: "challenge_not_found" });
    expect(await prisma.walletNonce.findUnique({ where: { id: link.id } })).not.toBeNull();
  });

  it("refuses an expired challenge, and consumes it", async () => {
    const c = await issued();
    const result = await consumeSignInChallenge({
      address: c.address,
      nonce: c.nonce,
      signature: sign(c.kp, c.message),
      now: new Date(c.expiresAt.getTime() + 1),
    });

    expect(result).toEqual({ ok: false, reason: "challenge_expired" });
    expect(await signInRows(c.address)).toBe(0);
  });

  it("checks expiry before the address", async () => {
    const c = await issued();
    const other = Keypair.random();
    const result = await consumeSignInChallenge({
      address: other.publicKey(),
      nonce: c.nonce,
      signature: sign(other, c.message),
      now: new Date(c.expiresAt.getTime() + 1),
    });
    expect(result).toEqual({ ok: false, reason: "challenge_expired" });
  });

  it("refuses a proof for a different address than the challenge was issued to", async () => {
    const c = await issued();
    const other = Keypair.random();
    const result = await consumeSignInChallenge({
      address: other.publicKey(),
      nonce: c.nonce,
      signature: sign(other, c.message),
    });
    expect(result).toEqual({ ok: false, reason: "wrong_address" });
  });

  it("compares the address exactly: a lowercased address is a different address", async () => {
    const c = await issued();
    const result = await consumeSignInChallenge({
      address: c.address.toLowerCase(),
      nonce: c.nonce,
      signature: sign(c.kp, c.message),
    });
    expect(result).toEqual({ ok: false, reason: "wrong_address" });
  });

  it("refuses a challenge issued on another network", async () => {
    const c = await issued();
    process.env.STELLAR_NETWORK = "public";
    const result = await consumeSignInChallenge({
      address: c.address,
      nonce: c.nonce,
      signature: sign(c.kp, c.message),
    });
    expect(result).toEqual({ ok: false, reason: "wrong_network" });
  });

  it("refuses when the wallet reports a different signer", async () => {
    const c = await issued();
    const result = await consumeSignInChallenge({
      address: c.address,
      nonce: c.nonce,
      signature: sign(c.kp, c.message),
      signerAddress: Keypair.random().publicKey(),
    });
    expect(result).toEqual({ ok: false, reason: "wrong_signer" });
  });

  describe("bad signatures", () => {
    const cases: Array<[string, (kp: Keypair, message: string) => string]> = [
      ["signed by a different key", (_kp, message) => sign(Keypair.random(), message)],
      [
        "signed over the raw message instead of the SEP-53 digest",
        (kp, message) => kp.sign(Buffer.from(message, "utf8")).toString("base64"),
      ],
      [
        "bit-flipped",
        (kp, message) => {
          const bytes = Buffer.from(sign(kp, message), "base64");
          bytes[0] ^= 0x01;
          return bytes.toString("base64");
        },
      ],
      [
        "truncated",
        (kp, message) => Buffer.from(sign(kp, message), "base64").subarray(0, 63).toString("base64"),
      ],
      ["not base64 at all", () => "not a signature!!"],
    ];

    it.each(cases)("refuses a signature %s, and consumes the challenge", async (_name, forge) => {
      const c = await issued();
      const result = await consumeSignInChallenge({
        address: c.address,
        nonce: c.nonce,
        signature: forge(c.kp, c.message),
      });
      expect(result).toEqual({ ok: false, reason: "bad_signature" });
      expect(await signInRows(c.address)).toBe(0);
    });
  });

  it("does not let a failed attempt be corrected against the same challenge", async () => {
    const c = await issued();
    const bad = await consumeSignInChallenge({
      address: c.address,
      nonce: c.nonce,
      signature: sign(Keypair.random(), c.message),
    });
    expect(bad).toEqual({ ok: false, reason: "bad_signature" });

    const retry = await consumeSignInChallenge({
      address: c.address,
      nonce: c.nonce,
      signature: sign(c.kp, c.message),
    });
    expect(retry).toEqual({ ok: false, reason: "challenge_not_found" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/stellar/__tests__/auth-challenge.test.ts`
Expected: FAIL. `@/lib/stellar/auth-challenge` cannot be resolved.

- [ ] **Step 3: Implement the module**

> **Post-review amendment:** The issuance portion of the original implementation
> snippet below is superseded by refinement 4 above and the checked-in module:
> live challenges are reused under the composite unique constraint, conflict
> rereads use a fresh clock, and missing/expired/consumed winners trigger a
> bounded retry. The verification and identity-resolution portions are unchanged.

Create `lib/stellar/auth-challenge.ts`:

```ts
// Wallet sign-in challenges (#25): prove control of a Stellar address, without
// an email/password session, by signing a one-time server challenge.
//
// The signed format and its bindings were settled on the real Freighter
// extension by #24 (docs/superpowers/specs/2026-09-14-freighter-wallet-signing-design.md).
// This module is that proof made durable: the harness kept challenges in
// process memory, but `web` can run more than one process and restarts lose
// memory, so production keeps them in `wallet_nonces`, tagged with
// PROOF_ACTION so the payout-link flow's rows are never touched.
import { randomBytes } from "crypto";
import prisma from "../prisma";
import { Prisma } from "@/app/generated/prisma/client";
import { networkPassphrase } from "./config";
import { isValidStellarAddress, verify } from "./signature";
import { CHALLENGE_TTL_MS, PROOF_ACTION, buildChallengeMessage } from "./challenge-message";

export interface IssuedSignInChallenge {
  nonce: string;
  message: string;
  expiresAt: Date;
}

/**
 * Issue a sign-in challenge for `address`.
 *
 * Replaces any earlier sign-in challenge for the same address, so each address
 * has at most one outstanding, and prunes every expired row while it is here,
 * so the table stays proportional to live challenges. Payout-link challenges
 * that have not expired are left alone.
 */
export async function issueSignInChallenge(
  address: string,
  now: Date = new Date(),
): Promise<IssuedSignInChallenge> {
  // Callers validate first; this is the backstop. Never normalize: StrKey is
  // case-sensitive, and a lowercased key is a different, invalid key.
  if (!isValidStellarAddress(address)) {
    throw new Error("issueSignInChallenge: address is not a valid Stellar G… key");
  }

  const fields = {
    address,
    networkPassphrase: networkPassphrase(),
    nonce: randomBytes(16).toString("hex"),
    issuedAt: now,
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
  };

  await prisma.$transaction([
    prisma.walletNonce.deleteMany({ where: { walletAddress: address, action: PROOF_ACTION } }),
    prisma.walletNonce.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.walletNonce.create({
      data: {
        walletAddress: fields.address,
        action: PROOF_ACTION,
        networkPassphrase: fields.networkPassphrase,
        nonce: fields.nonce,
        issuedAt: fields.issuedAt,
        expiresAt: fields.expiresAt,
      },
    }),
  ]);

  return { nonce: fields.nonce, message: buildChallengeMessage(fields), expiresAt: fields.expiresAt };
}

export type SignInRejection =
  | "challenge_not_found"
  | "challenge_expired"
  | "wrong_address"
  | "wrong_network"
  | "wrong_signer"
  | "bad_signature";

export type SignInProofResult =
  | { ok: true; address: string }
  | { ok: false; reason: SignInRejection };

/**
 * Verify a sign-in proof, consuming its challenge.
 *
 * The first step is a single delete by nonce and action. It is the only thing
 * that grants access: two concurrent attempts with the same nonce race on that
 * delete, and exactly one gets the row. It also runs before every other check,
 * so any attempt — accepted or not — uses the challenge up, and a failed proof
 * cannot be corrected and retried. A replay finds no row.
 *
 * The signed message is rebuilt from the stored row, never from anything the
 * client sent.
 */
export async function consumeSignInChallenge({
  address,
  nonce,
  signature,
  signerAddress,
  now = new Date(),
}: {
  address: string;
  nonce: string;
  signature: string;
  signerAddress?: string;
  now?: Date;
}): Promise<SignInProofResult> {
  let row;
  try {
    row = await prisma.walletNonce.delete({ where: { nonce, action: PROOF_ACTION } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { ok: false, reason: "challenge_not_found" };
    }
    throw err;
  }

  if (now.getTime() > row.expiresAt.getTime()) return { ok: false, reason: "challenge_expired" };
  if (row.walletAddress !== address) return { ok: false, reason: "wrong_address" };

  const passphrase = networkPassphrase();
  if (row.networkPassphrase !== passphrase) return { ok: false, reason: "wrong_network" };

  if (signerAddress !== undefined && signerAddress !== address) {
    return { ok: false, reason: "wrong_signer" };
  }

  const message = buildChallengeMessage({
    address: row.walletAddress,
    networkPassphrase: passphrase,
    nonce: row.nonce,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
  });
  if (!verify(address, message, signature)) return { ok: false, reason: "bad_signature" };

  return { ok: true, address };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/stellar/__tests__/auth-challenge.test.ts`
Expected: PASS, every test.

If only the `challenge_not_found` cases fail with an uncaught error, Prisma 7's driver adapter reported the missing row under a code other than `P2025`. Print `err.code` in the catch, match that code instead, and keep the tests unchanged.

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add lib/stellar/auth-challenge.ts lib/stellar/__tests__/auth-challenge.test.ts
git commit -m "feat(auth): issue and consume one-time wallet sign-in challenges in the database"
```

---

### Task 4: Resolve a proven address to one contributor

**Files:**
- Modify: `lib/stellar/auth-challenge.ts`
- Modify: `lib/stellar/__tests__/auth-challenge.test.ts`

**Interfaces:**
- Consumes: the existing `User.walletAddress @unique`.
- Produces:
  - `type WalletUserClient = { user: Pick<PrismaClient["user"], "findUnique" | "create"> }`
  - `findOrCreateWalletUser(walletAddress: string, client?: WalletUserClient): Promise<{ id: string; created: boolean }>`

- [ ] **Step 1: Write the failing tests**

In `lib/stellar/__tests__/auth-challenge.test.ts`, change the imports at the top to:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { Prisma } from "@/app/generated/prisma/client";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { sep53Digest } from "@/lib/stellar/signature";
import {
  CHALLENGE_TTL_MS,
  PROOF_ACTION,
  WALLET_LINK_ACTION,
  buildChallengeMessage,
} from "@/lib/stellar/challenge-message";
import {
  consumeSignInChallenge,
  findOrCreateWalletUser,
  issueSignInChallenge,
  type WalletUserClient,
} from "@/lib/stellar/auth-challenge";
```

Append to the end of the file:

```ts
describe("findOrCreateWalletUser", () => {
  it("resolves an existing wallet-only contributor to itself", async () => {
    const walletAddress = Keypair.random().publicKey();
    const existing = await prisma.user.create({ data: { walletAddress }, select: { id: true } });

    expect(await findOrCreateWalletUser(walletAddress)).toEqual({ id: existing.id, created: false });
  });

  it("resolves an email account that linked the address to that account", async () => {
    const walletAddress = Keypair.random().publicKey();
    const emailUser = await prisma.user.create({
      data: { email: "linked@example.com", passwordHash: "x", isVerified: true, walletAddress },
      select: { id: true },
    });

    expect(await findOrCreateWalletUser(walletAddress)).toEqual({ id: emailUser.id, created: false });
  });

  it("creates exactly one wallet-only contributor for an unknown address", async () => {
    const walletAddress = Keypair.random().publicKey();

    const result = await findOrCreateWalletUser(walletAddress);

    expect(result.created).toBe(true);
    const users = await prisma.user.findMany({ where: { walletAddress } });
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ id: result.id, email: null, passwordHash: null });
  });

  it("never splits one address into two contributors under concurrent first sign-ins", async () => {
    const walletAddress = Keypair.random().publicKey();

    const results = await Promise.all([
      findOrCreateWalletUser(walletAddress),
      findOrCreateWalletUser(walletAddress),
      findOrCreateWalletUser(walletAddress),
    ]);

    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await prisma.user.count({ where: { walletAddress } })).toBe(1);
  });

  it("falls back to the winning row when its create loses the unique-index race", async () => {
    const findUnique = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "winner" });
    const create = vi.fn().mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    const client = { user: { findUnique, create } } as unknown as WalletUserClient;

    const result = await findOrCreateWalletUser(Keypair.random().publicKey(), client);

    expect(result).toEqual({ id: "winner", created: false });
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("rethrows any other create failure", async () => {
    const boom = new Error("connection reset");
    const client = {
      user: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockRejectedValue(boom) },
    } as unknown as WalletUserClient;

    await expect(findOrCreateWalletUser(Keypair.random().publicKey(), client)).rejects.toBe(boom);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/stellar/__tests__/auth-challenge.test.ts -t findOrCreateWalletUser`
Expected: FAIL. `findOrCreateWalletUser` is not exported.

- [ ] **Step 3: Implement it**

In `lib/stellar/auth-challenge.ts`, change the generated-client import to:

```ts
import { Prisma, type PrismaClient } from "@/app/generated/prisma/client";
```

Append to the end of the file:

```ts
/** The slice of Prisma `findOrCreateWalletUser` uses, so the race path is testable. */
export type WalletUserClient = { user: Pick<PrismaClient["user"], "findUnique" | "create"> };

/**
 * Resolve a proven Stellar address to exactly one contributor.
 *
 * The `User` holding the address wins, including an email account that linked
 * it through `/api/me/wallet`. Otherwise a wallet-only `User` is created.
 * `User.walletAddress` is `@unique`, so when two first sign-ins race, one create
 * fails with P2002 and resolves to the row the other created: one address never
 * becomes two identities.
 *
 * Find-then-create rather than `upsert`: Prisma may run an upsert as a native
 * `INSERT … ON CONFLICT`, which cannot report whether it created the row.
 */
export async function findOrCreateWalletUser(
  walletAddress: string,
  client: WalletUserClient = prisma,
): Promise<{ id: string; created: boolean }> {
  const existing = await client.user.findUnique({ where: { walletAddress }, select: { id: true } });
  if (existing) return { id: existing.id, created: false };

  try {
    const user = await client.user.create({ data: { walletAddress }, select: { id: true } });
    return { id: user.id, created: true };
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    const winner = await client.user.findUnique({ where: { walletAddress }, select: { id: true } });
    if (!winner) throw err;
    return { id: winner.id, created: false };
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/stellar/__tests__/auth-challenge.test.ts`
Expected: PASS, every test in the file.

Run: `npm run typecheck`
Expected: exits 0. If `client: WalletUserClient = prisma` does not type-check because of Prisma's generic delegate signatures, change the default to `client: WalletUserClient = prisma as unknown as WalletUserClient`, and keep the rest as written.

- [ ] **Step 5: Commit**

```bash
git add lib/stellar/auth-challenge.ts lib/stellar/__tests__/auth-challenge.test.ts
git commit -m "feat(auth): resolve a proven Stellar address to exactly one contributor"
```

---

### Task 5: The challenge route

**Files:**
- Create: `app/api/auth/wallet/challenge/route.ts`
- Create: `app/api/auth/wallet/challenge/__tests__/route.test.ts`

**Interfaces:**
- Consumes:
  - from Task 3: `issueSignInChallenge`;
  - existing: `isValidStellarAddress`, and `checkWalletRateLimit(bucketKey: string): Promise<boolean>` (true means limited).
- Produces: `POST /api/auth/wallet/challenge`.
  - Request: `{ address }`.
  - Responses: 200 `{ nonce, message, expiresAt: string }`, 400 `{ error: "invalid_address" }`, 429 `{ error: "rate_limited" }`.

- [ ] **Step 1: Write the failing tests**

Create `app/api/auth/wallet/challenge/__tests__/route.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { Keypair, Networks } from "@stellar/stellar-sdk";

vi.mock("@/lib/rate-limit", () => ({ checkWalletRateLimit: vi.fn(async () => false) }));

import { POST } from "@/app/api/auth/wallet/challenge/route";
import { checkWalletRateLimit } from "@/lib/rate-limit";
import { PROOF_ACTION, buildChallengeMessage } from "@/lib/stellar/challenge-message";
import { prisma, truncateAll } from "@/tests/helpers/db";

const IP = "203.0.113.7";
const ORIGINAL_NETWORK = process.env.STELLAR_NETWORK;

function makeReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/auth/wallet/challenge", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": IP },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(async () => {
  process.env.STELLAR_NETWORK = "testnet";
  await truncateAll();
  vi.mocked(checkWalletRateLimit).mockReset().mockResolvedValue(false);
});

afterEach(() => {
  if (ORIGINAL_NETWORK === undefined) delete process.env.STELLAR_NETWORK;
  else process.env.STELLAR_NETWORK = ORIGINAL_NETWORK;
});

describe("POST /api/auth/wallet/challenge", () => {
  it("issues a challenge without any session", async () => {
    const address = Keypair.random().publicKey();

    const res = await POST(makeReq({ address }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);

    const row = await prisma.walletNonce.findUniqueOrThrow({ where: { nonce: body.nonce } });
    expect(row.action).toBe(PROOF_ACTION);
    expect(body.expiresAt).toBe(row.expiresAt.toISOString());
    expect(body.message).toBe(
      buildChallengeMessage({
        address,
        networkPassphrase: Networks.TESTNET,
        nonce: body.nonce,
        issuedAt: row.issuedAt,
        expiresAt: row.expiresAt,
      }),
    );
  });

  it.each([
    ["a lowercased address", () => ({ address: Keypair.random().publicKey().toLowerCase() })],
    ["a non-StrKey address", () => ({ address: "0xdeadbeef" })],
    ["a missing address", () => ({})],
    ["a non-string address", () => ({ address: 42 })],
    ["a non-JSON body", () => "not json"],
  ])("400 invalid_address for %s, issuing nothing", async (_name, body) => {
    const res = await POST(makeReq(body()));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_address" });
    expect(await prisma.walletNonce.count()).toBe(0);
    expect(checkWalletRateLimit).not.toHaveBeenCalled();
  });

  it("429 when the caller's IP is throttled, issuing nothing", async () => {
    vi.mocked(checkWalletRateLimit).mockResolvedValueOnce(true);

    const res = await POST(makeReq({ address: Keypair.random().publicKey() }));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(checkWalletRateLimit).toHaveBeenCalledWith(`auth-challenge-ip:${IP}`);
    expect(await prisma.walletNonce.count()).toBe(0);
  });

  it("429 when the address is throttled, issuing nothing", async () => {
    const address = Keypair.random().publicKey();
    vi.mocked(checkWalletRateLimit).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const res = await POST(makeReq({ address }));

    expect(res.status).toBe(429);
    expect(checkWalletRateLimit).toHaveBeenCalledWith(`auth-challenge:${address}`);
    expect(await prisma.walletNonce.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/api/auth/wallet/challenge/__tests__/route.test.ts`
Expected: FAIL. `@/app/api/auth/wallet/challenge/route` cannot be resolved.

- [ ] **Step 3: Implement the route**

Create `app/api/auth/wallet/challenge/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { isValidStellarAddress } from "@/lib/stellar/signature";
import { issueSignInChallenge } from "@/lib/stellar/auth-challenge";
import { checkWalletRateLimit } from "@/lib/rate-limit";

function clientIp(req: NextRequest): string {
  // x-real-ip is set by Railway's proxy and cannot be overridden by the client;
  // the first x-forwarded-for entry can. Same reasoning as /api/auth/login.
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * POST /api/auth/wallet/challenge — issue a one-time wallet sign-in challenge (#25).
 *
 * Public: a contributor has no session yet. The response carries the exact text
 * to sign with Freighter's `signMessage`; the proof goes to
 * `/api/auth/wallet/verify`, within five minutes, once.
 *
 * Two throttles, because the endpoint writes a row and needs no session: per
 * address, which bounds churn on one address, and per IP, which bounds a caller
 * looping fresh addresses.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const address =
    body && typeof body === "object" && typeof (body as { address?: unknown }).address === "string"
      ? (body as { address: string }).address
      : "";

  // No normalization: StrKey is case-sensitive, so a lowercased key is refused.
  if (!isValidStellarAddress(address)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }

  if (await checkWalletRateLimit(`auth-challenge-ip:${clientIp(req)}`)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  if (await checkWalletRateLimit(`auth-challenge:${address}`)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const challenge = await issueSignInChallenge(address);
  return NextResponse.json({
    nonce: challenge.nonce,
    message: challenge.message,
    expiresAt: challenge.expiresAt.toISOString(),
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run app/api/auth/wallet/challenge/__tests__/route.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add app/api/auth/wallet/challenge
git commit -m "feat(auth): add the public wallet sign-in challenge endpoint"
```

---

### Task 6: The verify route

**Files:**
- Create: `app/api/auth/wallet/verify/route.ts`
- Create: `app/api/auth/wallet/verify/__tests__/route.test.ts`

**Interfaces:**
- Consumes:
  - from Tasks 3–4: `issueSignInChallenge`, `consumeSignInChallenge`, `findOrCreateWalletUser`;
  - existing: `signLabelerJWT(userId)`, `setLabelerSessionCookie(res, token)`, `verifyLabelerJWT(token)`.
- Produces: `POST /api/auth/wallet/verify`.
  - Request: `{ address, nonce, signature, signerAddress? }`.
  - Responses:
    - 200 `{ success: true, userId, walletAddress, created }`, plus the `labeler_session` cookie;
    - 400 `{ error: "invalid_body" | "invalid_address" }`;
    - 401 `{ error: SignInRejection }`.

- [ ] **Step 1: Write the failing tests**

Create `app/api/auth/wallet/verify/__tests__/route.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";

import { POST } from "@/app/api/auth/wallet/verify/route";
import { issueSignInChallenge } from "@/lib/stellar/auth-challenge";
import { sep53Digest } from "@/lib/stellar/signature";
import { signLabelerJWT, verifyLabelerJWT } from "@/lib/labeler-auth";
import { prisma, truncateAll } from "@/tests/helpers/db";

// Real database throughout: the concurrent replay case below is the property
// that only the database can decide.

const ORIGINAL_NETWORK = process.env.STELLAR_NETWORK;

beforeEach(async () => {
  process.env.STELLAR_NETWORK = "testnet";
  await truncateAll();
});

afterEach(() => {
  if (ORIGINAL_NETWORK === undefined) delete process.env.STELLAR_NETWORK;
  else process.env.STELLAR_NETWORK = ORIGINAL_NETWORK;
});

const sign = (kp: Keypair, message: string) => kp.sign(sep53Digest(message)).toString("base64");

function makeReq(body: unknown, cookie?: string): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new NextRequest("http://localhost/api/auth/wallet/verify", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function sessionCookies(res: Response): string[] {
  return res.headers.getSetCookie().filter((c) => c.startsWith("labeler_session="));
}

async function sessionUserId(res: Response): Promise<string | undefined> {
  const [cookie] = sessionCookies(res);
  if (!cookie) return undefined;
  const token = cookie.split(";")[0].split("=")[1];
  return (await verifyLabelerJWT(token))?.sub;
}

/** A contributor keypair with a freshly issued challenge and a valid proof for it. */
async function validProof(kp = Keypair.random()) {
  const challenge = await issueSignInChallenge(kp.publicKey());
  return {
    kp,
    challenge,
    body: {
      address: kp.publicKey(),
      nonce: challenge.nonce,
      signature: sign(kp, challenge.message),
      signerAddress: kp.publicKey(),
    },
  };
}

describe("POST /api/auth/wallet/verify — success", () => {
  it("issues exactly one wallet-keyed session and creates the contributor", async () => {
    const { body } = await validProof();

    const res = await POST(makeReq(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    const user = await prisma.user.findUniqueOrThrow({ where: { walletAddress: body.address } });
    expect(json).toEqual({ success: true, userId: user.id, walletAddress: body.address, created: true });

    expect(sessionCookies(res)).toHaveLength(1);
    expect(sessionCookies(res)[0]).toMatch(/HttpOnly/);
    expect(await sessionUserId(res)).toBe(user.id);
    expect(await prisma.user.count({ where: { walletAddress: body.address } })).toBe(1);
  });

  it("signs a returning wallet contributor in as itself", async () => {
    const kp = Keypair.random();
    const existing = await prisma.user.create({ data: { walletAddress: kp.publicKey() } });
    const { body } = await validProof(kp);

    const res = await POST(makeReq(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: existing.id, created: false });
    expect(await sessionUserId(res)).toBe(existing.id);
  });

  it("signs an email account that linked the address in as that account", async () => {
    const kp = Keypair.random();
    const emailUser = await prisma.user.create({
      data: { email: "linked@example.com", passwordHash: "x", isVerified: true, walletAddress: kp.publicKey() },
    });
    const { body } = await validProof(kp);

    const res = await POST(makeReq(body));

    expect(await res.json()).toMatchObject({ userId: emailUser.id, created: false });
    expect(await sessionUserId(res)).toBe(emailUser.id);
  });

  it("replaces an existing session with the proven address's contributor", async () => {
    const other = await prisma.user.create({ data: { email: "other@example.com" } });
    const { body } = await validProof();

    const res = await POST(makeReq(body, `labeler_session=${await signLabelerJWT(other.id)}`));

    expect(res.status).toBe(200);
    const { userId } = await res.json();
    expect(userId).not.toBe(other.id);
    expect(await sessionUserId(res)).toBe(userId);
  });

  it("accepts a proof without signerAddress", async () => {
    const { body } = await validProof();
    const withoutSigner = { address: body.address, nonce: body.nonce, signature: body.signature };

    const res = await POST(makeReq(withoutSigner));

    expect(res.status).toBe(200);
  });
});

describe("POST /api/auth/wallet/verify — rejections", () => {
  async function expectRejected(res: Response, status: number, error: string) {
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
    expect(sessionCookies(res)).toHaveLength(0);
  }

  it("401 challenge_not_found on a replay of an accepted proof", async () => {
    const { body } = await validProof();
    expect((await POST(makeReq(body))).status).toBe(200);

    await expectRejected(await POST(makeReq(body)), 401, "challenge_not_found");
  });

  it("gives exactly one session when the same proof arrives twice at once", async () => {
    const { body } = await validProof();

    const results = await Promise.all([POST(makeReq(body)), POST(makeReq(body))]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    const rejected = results.find((r) => r.status === 401)!;
    expect(await rejected.json()).toEqual({ error: "challenge_not_found" });
    expect(results.flatMap(sessionCookies)).toHaveLength(1);
    expect(await prisma.user.count({ where: { walletAddress: body.address } })).toBe(1);
  });

  it("401 challenge_not_found for an unknown nonce", async () => {
    const { body } = await validProof();
    await expectRejected(await POST(makeReq({ ...body, nonce: "f".repeat(32) })), 401, "challenge_not_found");
  });

  it("401 challenge_expired for a challenge past its expiry", async () => {
    const { body, challenge } = await validProof();
    await prisma.walletNonce.update({
      where: { nonce: challenge.nonce },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expectRejected(await POST(makeReq(body)), 401, "challenge_expired");
  });

  it("401 wrong_address for a challenge issued to another address", async () => {
    const { challenge } = await validProof();
    const other = Keypair.random();

    const res = await POST(
      makeReq({ address: other.publicKey(), nonce: challenge.nonce, signature: sign(other, challenge.message) }),
    );

    await expectRejected(res, 401, "wrong_address");
  });

  it("401 wrong_network for a challenge issued on the other network", async () => {
    const { body } = await validProof();
    process.env.STELLAR_NETWORK = "public";

    await expectRejected(await POST(makeReq(body)), 401, "wrong_network");
  });

  it("401 wrong_signer when the wallet reports a different signer", async () => {
    const { body } = await validProof();
    await expectRejected(
      await POST(makeReq({ ...body, signerAddress: Keypair.random().publicKey() })),
      401,
      "wrong_signer",
    );
  });

  it.each([
    ["by a different key", (_kp: Keypair, message: string) => sign(Keypair.random(), message)],
    ["over the raw message", (kp: Keypair, message: string) => kp.sign(Buffer.from(message, "utf8")).toString("base64")],
    ["truncated", (kp: Keypair, message: string) => Buffer.from(sign(kp, message), "base64").subarray(0, 63).toString("base64")],
    ["that is not base64", () => "not a signature!!"],
  ])("401 bad_signature for a signature %s, consuming the challenge", async (_name, forge) => {
    const { kp, challenge, body } = await validProof();

    await expectRejected(
      await POST(makeReq({ ...body, signature: forge(kp, challenge.message) })),
      401,
      "bad_signature",
    );
    expect(await prisma.walletNonce.count({ where: { nonce: challenge.nonce } })).toBe(0);
  });

  it("400 invalid_address for a lowercased address, without consuming the challenge", async () => {
    const { body, challenge } = await validProof();

    await expectRejected(
      await POST(makeReq({ ...body, address: body.address.toLowerCase() })),
      400,
      "invalid_address",
    );
    expect(await prisma.walletNonce.count({ where: { nonce: challenge.nonce } })).toBe(1);
  });

  it.each([
    ["a non-JSON body", () => "not json"],
    ["a missing nonce", (b: Record<string, unknown>) => ({ ...b, nonce: undefined })],
    ["an empty nonce", (b: Record<string, unknown>) => ({ ...b, nonce: "" })],
    ["a missing signature", (b: Record<string, unknown>) => ({ ...b, signature: undefined })],
    ["a non-string signature", (b: Record<string, unknown>) => ({ ...b, signature: 123 })],
    ["a non-string signerAddress", (b: Record<string, unknown>) => ({ ...b, signerAddress: 7 })],
  ])("400 invalid_body for %s, without consuming the challenge", async (_name, mutate) => {
    const { body, challenge } = await validProof();

    await expectRejected(await POST(makeReq(mutate(body))), 400, "invalid_body");
    expect(await prisma.walletNonce.count({ where: { nonce: challenge.nonce } })).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/api/auth/wallet/verify/__tests__/route.test.ts`
Expected: FAIL. `@/app/api/auth/wallet/verify/route` cannot be resolved.

- [ ] **Step 3: Implement the route**

Create `app/api/auth/wallet/verify/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { isValidStellarAddress } from "@/lib/stellar/signature";
import { consumeSignInChallenge, findOrCreateWalletUser } from "@/lib/stellar/auth-challenge";
import { setLabelerSessionCookie, signLabelerJWT } from "@/lib/labeler-auth";

/**
 * POST /api/auth/wallet/verify — sign in by proving control of a Stellar address (#25).
 *
 * Body: `{ address, nonce, signature, signerAddress? }`, where `signature` is
 * Freighter's SEP-53 `signMessage` result (base64) over the challenge from
 * `/api/auth/wallet/challenge`, and `signerAddress` is the signer Freighter
 * reported.
 *
 * A malformed request is a 400 and leaves the challenge untouched. Everything
 * past that point consumes the challenge, whatever the outcome, so a failed
 * proof is a 401 and needs a new challenge.
 *
 * Success issues the same userId-keyed `labeler_session` as email login,
 * resolved by the proven address: the contributor holding it, or a new
 * wallet-only one. A request that already carries a session is signed in as the
 * proven address's contributor instead. Linking an address to an email account
 * is still `/api/me/wallet`'s job, not this route's.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { address, nonce, signature, signerAddress } = body as Record<string, unknown>;
  if (
    typeof nonce !== "string" ||
    !nonce ||
    typeof signature !== "string" ||
    !signature ||
    (signerAddress !== undefined && typeof signerAddress !== "string")
  ) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  // No normalization: StrKey is case-sensitive, so a lowercased key is refused.
  if (typeof address !== "string" || !isValidStellarAddress(address)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }

  const result = await consumeSignInChallenge({
    address,
    nonce,
    signature,
    signerAddress: signerAddress as string | undefined,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 401 });
  }

  const user = await findOrCreateWalletUser(result.address);
  const token = await signLabelerJWT(user.id);
  const res = NextResponse.json({
    success: true,
    userId: user.id,
    walletAddress: result.address,
    created: user.created,
  });
  return setLabelerSessionCookie(res, token);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run app/api/auth/wallet/verify/__tests__/route.test.ts`
Expected: PASS, every test.

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add app/api/auth/wallet/verify
git commit -m "feat(auth): sign contributors in by verifying a wallet ownership proof"
```

---

### Task 7: Full verification and pull request

**Files:** none new.

**Interfaces:**
- Consumes: everything above.
- Produces: a PR into `develop` that closes #25.

- [ ] **Step 1: Run the full suite, the payments lane, and the typecheck**

Run each, from the worktree root:

```bash
npm run typecheck
npm test
npm run test:payments
```

Expected: every command exits 0.

`npm test` is the same run as CI's `build` job. `test:payments` now also includes `lib/stellar/__tests__/challenge-message.test.ts` and `lib/stellar/__tests__/auth-challenge.test.ts` through the lane's glob, and both must pass there as well.

- [ ] **Step 2: Build**

`next build` needs `DATABASE_URL` to be set. Point it at the local test database:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/centient_test npm run build
```

Expected: the build succeeds, and its route list includes `/api/auth/wallet/challenge` and `/api/auth/wallet/verify`.

- [ ] **Step 3: Check commit identity**

```bash
git log origin/develop..HEAD --format='%h | A:%an <%ae> | trailers:[%(trailers)]'
```

Expected: every line reads `A:cemmacabales <carlmacabales31@gmail.com> | trailers:[]`. If any commit has a trailer, rewrite that commit's message without it before pushing.

- [ ] **Step 4: Push and open the PR**

Confirm with `cemmacabales` before pushing, because pushing publishes the branch.

```bash
git push -u origin feat/issue-25-signed-challenge-auth
gh pr create --base develop --title "[E2-2] Wallet signed-challenge sign-in with expiry and replay protection" --body-file "$PR_BODY"
```

First write the PR body to a file outside the repository, and set `PR_BODY` to its path. It must contain `Closes #25`, `Part of #21`, links to the spec and this plan, a summary of each task, and the Step 1–2 results. It must **not** contain any AI attribution line. The PR opens as ready for review. CI must be green, and the review must cover the current head SHA. Only `cemmacabales` merges.

- [ ] **Step 5: Update the roadmap**

In issue #60, set #25's row to 🟡 in progress with the PR link and head SHA, and add a dated revision-log entry. #26 stays blocked until the PR merges.

# ST-4e Sponsored USDC Trustlines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a labeler with 0 XLM receive USDC by having the platform sponsor (CAP-33) their USDC trustline — and, for a brand-new account, its creation — at withdrawal-link time, replacing ST-4b's hard `no_trustline` reject.

**Architecture:** Server builds a CAP-33 sandwich (`beginSponsoringFutureReserves` → [`createAccount`] → `changeTrust(USDC)` → `endSponsoringFutureReserves`), platform-signs it, and returns the XDR. Freighter adds the recipient's signature; the server re-asserts the op shape and submits to Horizon. Wallet-health subtracts the live sponsored-reserve liability (`0.5 XLM × num_sponsoring`, read from Horizon) from the XLM floor. No new DB state.

**Tech Stack:** TypeScript, Next.js App Router, `@stellar/stellar-sdk` (Horizon classic), `@stellar/freighter-api`, Vitest, Sentry.

## Global Constraints

- Branch `feat/stellar-4e-sponsored-trustlines` (already created off `stellar`); PRs target `stellar`, **never** `develop`.
- Stellar `G…` addresses are case-sensitive base32 — **never** `.toLowerCase()`/normalize them.
- USDC is an issued asset; the asset is always `usdcAsset()` from `lib/stellar/config.ts` (never hardcode code/issuer).
- Money is integer **units** (1 USDC = 10⁷ units); use `unitsToUsdcString`/`usdcToUnits`, never viem/`formatUnits`.
- Reuse `StellarPaymentError(message, code, retryable)` for chain-op failures; `retryable:false` must never be retried.
- Sponsored-reserve constant: **0.5 XLM per trustline** (`TRUSTLINE_RESERVE_XLM = 0.5`).
- Sequence strategy is **simple**: do not hold `seqMutex` across the browser round-trip; on `tx_bad_seq` the client re-runs the flow.
- Test convention: mock only `server()` (or `loadAccount`) at the config boundary; keep real config helpers, StrKey, and signing. Use throwaway `Keypair.random()`, never funded.
- Run tests with `npx vitest run <path>`. `npx tsc --noEmit` must stay clean.

---

### Task 1: `buildSponsoredTrustlineTx` — CAP-33 sandwich builder

**Files:**
- Modify: `lib/stellar/client.ts`
- Test: `lib/stellar/__tests__/client.test.ts`

**Interfaces:**
- Consumes: `server()`, `networkPassphrase()`, `usdcAsset()` from `./config`; `platformKeypair()`, `resultCodes()`, `TX_TIMEOUT_SECONDS`, `StellarPaymentError` (existing in `client.ts`).
- Produces: `buildSponsoredTrustlineTx(recipientG: string): Promise<{ xdr: string; kind: "trustline" | "account+trustline" }>`.

- [ ] **Step 1: Write the failing tests**

Add to `lib/stellar/__tests__/client.test.ts`. Note the existing `makeServer` returns a funded `loadAccount`; for the account-exists case we need `loadAccount` to succeed for the recipient too, and for the 404 case to throw for the recipient only.

```typescript
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { buildSponsoredTrustlineTx } from "../client";

// Horizon 404 shape (account not found).
const notFound = () => ({ response: { status: 404 } });

describe("buildSponsoredTrustlineTx", () => {
  it("builds a begin/changeTrust/end sandwich for an existing account", async () => {
    const recipient = Keypair.random().publicKey();
    const srv = makeServer({});
    // platform load (seq) + recipient load (exists) both succeed.
    srv.loadAccount = vi.fn(async (pub: string) => new Account(pub, "1000"));
    mockedServer.mockReturnValue(srv as never);

    const { xdr, kind } = await buildSponsoredTrustlineTx(recipient);
    expect(kind).toBe("trustline");

    // No STELLAR_NETWORK set → networkPassphrase() defaults to testnet.
    const tx = TransactionBuilder.fromXDR(xdr, "Test SDF Network ; September 2015");
    expect(tx.operations.map((o) => o.type)).toEqual([
      "beginSponsoringFutureReserves",
      "changeTrust",
      "endSponsoringFutureReserves",
    ]);
    // sponsor = platform (tx source); sponsored + trustline owner = recipient.
    expect(tx.source).toBe(platformKp.publicKey());
    expect((tx.operations[0] as { sponsoredId: string }).sponsoredId).toBe(recipient);
    expect(tx.operations[1].source).toBe(recipient);
    expect(tx.operations[2].source).toBe(recipient);
  });

  it("prepends createAccount(recipient, '0') when the account does not exist", async () => {
    const recipient = Keypair.random().publicKey();
    const srv = makeServer({});
    srv.loadAccount = vi.fn(async (pub: string) => {
      if (pub === recipient) throw notFound();
      return new Account(pub, "1000");
    });
    mockedServer.mockReturnValue(srv as never);

    const { xdr, kind } = await buildSponsoredTrustlineTx(recipient);
    expect(kind).toBe("account+trustline");
    const tx = TransactionBuilder.fromXDR(xdr, "Test SDF Network ; September 2015");
    expect(tx.operations.map((o) => o.type)).toEqual([
      "beginSponsoringFutureReserves",
      "createAccount",
      "changeTrust",
      "endSponsoringFutureReserves",
    ]);
    expect((tx.operations[1] as { destination: string; startingBalance: string }).destination).toBe(recipient);
    expect((tx.operations[1] as { startingBalance: string }).startingBalance).toBe("0");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/stellar/__tests__/client.test.ts -t "buildSponsoredTrustlineTx"`
Expected: FAIL — `buildSponsoredTrustlineTx is not a function`.

- [ ] **Step 3: Implement `buildSponsoredTrustlineTx`**

Add to `lib/stellar/client.ts`. Add `Asset`-free imports already present; add `TransactionBuilder`, `Operation`, `Account`, `BASE_FEE` are already imported. Add near the bottom (after `accountHasUsdcTrustline`):

```typescript
/**
 * Does `address` exist on-chain? A Horizon 404 means the account is unfunded /
 * never created (so it needs sponsored creation before it can hold a trustline).
 */
async function accountExists(address: string): Promise<boolean> {
  try {
    await server().loadAccount(address);
    return true;
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) return false;
    throw err;
  }
}

/**
 * Build a CAP-33 platform-sponsored USDC-trustline transaction for `recipientG`
 * and platform-sign it. The platform is the transaction source (sequence + fee)
 * and the sponsor; the recipient owns (and must also sign) the `changeTrust` and
 * `endSponsoring` ops, but pays no reserve. If the recipient account does not yet
 * exist, a sponsored `createAccount(recipient, "0")` is prepended.
 *
 * Sequence: built from the platform's *current* sequence but submitted later
 * (after the recipient signs in-browser), so a concurrent payUsdc may consume it
 * first → tx_bad_seq at submit; the caller re-runs the flow (simple strategy,
 * ST-4e #314). Returns the base64 XDR for the browser to co-sign.
 */
export async function buildSponsoredTrustlineTx(
  recipientG: string,
): Promise<{ xdr: string; kind: "trustline" | "account+trustline" }> {
  const kp = platformKeypair();
  const srv = server();
  const account = await srv.loadAccount(kp.publicKey());
  const fee = await srv.fetchBaseFee().catch(() => Number(BASE_FEE));
  const exists = await accountExists(recipientG);

  const builder = new TransactionBuilder(account, {
    fee: String(fee),
    networkPassphrase: networkPassphrase(),
  }).addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: recipientG }));

  if (!exists) {
    builder.addOperation(
      Operation.createAccount({ destination: recipientG, startingBalance: "0" }),
    );
  }

  const tx = builder
    .addOperation(Operation.changeTrust({ asset: usdcAsset(), source: recipientG }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: recipientG }))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();
  tx.sign(kp);

  return { xdr: tx.toXDR(), kind: exists ? "trustline" : "account+trustline" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/stellar/__tests__/client.test.ts -t "buildSponsoredTrustlineTx"`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add lib/stellar/client.ts lib/stellar/__tests__/client.test.ts
git commit -m "feat(stellar): ST-4e — buildSponsoredTrustlineTx CAP-33 sandwich (#314)"
```

---

### Task 2: `submitSponsoredTrustline` — validate shape + submit + map result codes

**Files:**
- Modify: `lib/stellar/client.ts`
- Test: `lib/stellar/__tests__/client.test.ts`

**Interfaces:**
- Consumes: `server()`, `networkPassphrase()`, `usdcAsset()`, `resultCodes()`, `StellarPaymentError` (existing).
- Produces: `submitSponsoredTrustline(signedXdr: string): Promise<{ hash: string }>`. Throws `StellarPaymentError` with codes `op_low_reserve` (retryable:false), `tx_bad_seq` (retryable:true), `invalid_sponsor_tx` (retryable:false).

- [ ] **Step 1: Write the failing tests**

```typescript
import { Operation } from "@stellar/stellar-sdk";
import { submitSponsoredTrustline } from "../client";

const PASSPHRASE = "Test SDF Network ; September 2015";

// Build a valid recipient-signed-looking sandwich XDR for submit tests. Platform
// + recipient both sign so the envelope parses; Horizon is mocked so real
// signature verification never runs.
function sandwichXdr(recipient: Keypair): string {
  const account = new Account(platformKp.publicKey(), "1000");
  const tx = new (require("@stellar/stellar-sdk").TransactionBuilder)(account, {
    fee: "300",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: recipient.publicKey() }))
    .addOperation(Operation.changeTrust({ asset: makeUsdc(), source: recipient.publicKey() }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: recipient.publicKey() }))
    .setTimeout(180)
    .build();
  tx.sign(platformKp, recipient);
  return tx.toXDR();
}
function makeUsdc() {
  const { Asset } = require("@stellar/stellar-sdk");
  return new Asset("USDC", process.env.STELLAR_USDC_ISSUER!);
}
// A tampered envelope: an extra payment op the platform never sponsored.
function tamperedXdr(recipient: Keypair): string {
  const account = new Account(platformKp.publicKey(), "1000");
  const tx = new (require("@stellar/stellar-sdk").TransactionBuilder)(account, {
    fee: "200",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: recipient.publicKey() }))
    .addOperation(Operation.payment({ destination: recipient.publicKey(), asset: makeUsdc(), amount: "100" }))
    .setTimeout(180)
    .build();
  tx.sign(platformKp);
  return tx.toXDR();
}

const lowReserveError = () =>
  horizonError({ transaction: "tx_failed", operations: ["op_low_reserve"] });

describe("submitSponsoredTrustline", () => {
  it("submits a well-formed sandwich and returns the hash", async () => {
    const recipient = Keypair.random();
    mockedServer.mockReturnValue(
      makeServer({ submitTransaction: vi.fn(async () => ({ hash: "SPONSOR_HASH" })) }) as never,
    );
    const { hash } = await submitSponsoredTrustline(sandwichXdr(recipient));
    expect(hash).toBe("SPONSOR_HASH");
  });

  it("rejects a tampered envelope before submitting", async () => {
    const recipient = Keypair.random();
    const submit = vi.fn();
    mockedServer.mockReturnValue(makeServer({ submitTransaction: submit }) as never);
    await expect(submitSponsoredTrustline(tamperedXdr(recipient))).rejects.toMatchObject({
      code: "invalid_sponsor_tx",
      retryable: false,
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("maps op_low_reserve to a non-retryable error", async () => {
    const recipient = Keypair.random();
    mockedServer.mockReturnValue(
      makeServer({ submitTransaction: vi.fn(async () => { throw lowReserveError(); }) }) as never,
    );
    await expect(submitSponsoredTrustline(sandwichXdr(recipient))).rejects.toMatchObject({
      code: "op_low_reserve",
      retryable: false,
    });
  });

  it("maps tx_bad_seq to a retryable error", async () => {
    const recipient = Keypair.random();
    mockedServer.mockReturnValue(
      makeServer({ submitTransaction: vi.fn(async () => { throw badSeqError(); }) }) as never,
    );
    await expect(submitSponsoredTrustline(sandwichXdr(recipient))).rejects.toMatchObject({
      code: "tx_bad_seq",
      retryable: true,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/stellar/__tests__/client.test.ts -t "submitSponsoredTrustline"`
Expected: FAIL — `submitSponsoredTrustline is not a function`.

- [ ] **Step 3: Implement `submitSponsoredTrustline`**

Add to `lib/stellar/client.ts`:

```typescript
/**
 * Assert `xdr` is exactly a platform-sponsored USDC-trustline sandwich for a
 * single recipient — begin / [createAccount] / changeTrust(USDC) / end, no other
 * op types (esp. no payment). Defense in depth: the platform already signed a
 * fixed envelope (tampering invalidates that signature), but we re-check the
 * sponsored target + asset before submitting. Throws `invalid_sponsor_tx`.
 */
function assertSponsoredTrustlineShape(
  tx: import("@stellar/stellar-sdk").Transaction,
): void {
  const types = tx.operations.map((o) => o.type);
  const withAccount = ["beginSponsoringFutureReserves", "createAccount", "changeTrust", "endSponsoringFutureReserves"];
  const withoutAccount = ["beginSponsoringFutureReserves", "changeTrust", "endSponsoringFutureReserves"];
  const ok =
    JSON.stringify(types) === JSON.stringify(withAccount) ||
    JSON.stringify(types) === JSON.stringify(withoutAccount);
  if (!ok) {
    throw new StellarPaymentError(
      `submitSponsoredTrustline: unexpected op shape [${types.join(", ")}]`,
      "invalid_sponsor_tx",
      false,
    );
  }
  const begin = tx.operations[0] as { sponsoredId?: string };
  const changeTrust = tx.operations.find((o) => o.type === "changeTrust") as
    | { source?: string; line?: { code?: string; issuer?: string } }
    | undefined;
  const asset = usdcAsset();
  const sponsored = begin.sponsoredId;
  if (
    !sponsored ||
    !changeTrust ||
    changeTrust.source !== sponsored ||
    changeTrust.line?.code !== asset.getCode() ||
    changeTrust.line?.issuer !== asset.getIssuer()
  ) {
    throw new StellarPaymentError(
      "submitSponsoredTrustline: sponsored target / asset mismatch",
      "invalid_sponsor_tx",
      false,
    );
  }
}

/**
 * Submit a recipient-co-signed sponsored-trustline XDR (from
 * {@link buildSponsoredTrustlineTx}). Validates the op shape, then submits.
 * Maps: `op_low_reserve` → non-retryable (platform lacks XLM for the sponsored
 * reserves); `tx_bad_seq` → retryable (caller re-runs the flow); shape mismatch
 * → non-retryable `invalid_sponsor_tx`. A `changeTrust` on an already-trusting
 * line is idempotent, so a duplicate submission still succeeds.
 */
export async function submitSponsoredTrustline(
  signedXdr: string,
): Promise<{ hash: string }> {
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase());
  assertSponsoredTrustlineShape(tx as import("@stellar/stellar-sdk").Transaction);
  try {
    const res = await server().submitTransaction(tx);
    return { hash: res.hash };
  } catch (err) {
    if (err instanceof StellarPaymentError) throw err;
    const codes = resultCodes(err);
    if (codes.operations?.includes("op_low_reserve")) {
      throw new StellarPaymentError(
        "submitSponsoredTrustline: platform account cannot fund sponsored reserves (op_low_reserve)",
        "op_low_reserve",
        false,
      );
    }
    if (codes.transaction === "tx_bad_seq") {
      throw new StellarPaymentError(
        "submitSponsoredTrustline: stale sequence (tx_bad_seq) — rebuild and retry",
        "tx_bad_seq",
        true,
      );
    }
    throw err;
  }
}
```

Note: `TransactionBuilder.fromXDR` returns a `Transaction | FeeBumpTransaction`; since we always build a plain `Transaction`, the `.operations` access is valid. If `tsc` complains, cast via `as unknown as import("@stellar/stellar-sdk").Transaction` at the `fromXDR` call.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/stellar/__tests__/client.test.ts`
Expected: PASS (all client tests, old + new).

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add lib/stellar/client.ts lib/stellar/__tests__/client.test.ts
git commit -m "feat(stellar): ST-4e — submitSponsoredTrustline validate+submit (#314)"
```

---

### Task 3: `signTransaction` — Freighter transaction-signing wallet path

**Files:**
- Modify: `lib/stellar/wallet.ts`
- Test: `lib/stellar/__tests__/wallet.test.ts` (create if absent; otherwise extend)

**Interfaces:**
- Consumes: `isValidStellarAddress` from `./signature`; `isFreighterAvailable`, `assertAddress` (existing in `wallet.ts`); `networkPassphrase` from `./config`.
- Produces: `signTransaction(xdr: string, expectedAddress: string): Promise<string>` (returns signed XDR).

- [ ] **Step 1: Write the failing test**

Freighter is loaded via dynamic `import("@stellar/freighter-api")`, so mock that module. Create/extend `lib/stellar/__tests__/wallet.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

process.env.STELLAR_USDC_ISSUER = Keypair.random().publicKey();

const { mockIsConnected, mockSignTransaction } = vi.hoisted(() => ({
  mockIsConnected: vi.fn(),
  mockSignTransaction: vi.fn(),
}));

vi.mock("@stellar/freighter-api", () => ({
  isConnected: mockIsConnected,
  signTransaction: mockSignTransaction,
  requestAccess: vi.fn(),
  signMessage: vi.fn(),
}));

import { signTransaction } from "../wallet";

const ADDR = Keypair.random().publicKey();

beforeEach(() => {
  vi.clearAllMocks();
  mockIsConnected.mockResolvedValue({ isConnected: true });
});

describe("signTransaction", () => {
  it("returns the Freighter-signed XDR when the signer matches", async () => {
    mockSignTransaction.mockResolvedValue({ signedTxXdr: "SIGNED_XDR", signerAddress: ADDR });
    await expect(signTransaction("UNSIGNED_XDR", ADDR)).resolves.toBe("SIGNED_XDR");
  });

  it("throws when Freighter signs with the wrong account", async () => {
    const other = Keypair.random().publicKey();
    mockSignTransaction.mockResolvedValue({ signedTxXdr: "X", signerAddress: other });
    await expect(signTransaction("UNSIGNED_XDR", ADDR)).rejects.toThrow(/wrong account/);
  });

  it("throws Freighter's error", async () => {
    mockSignTransaction.mockResolvedValue({ error: { message: "user declined" } });
    await expect(signTransaction("UNSIGNED_XDR", ADDR)).rejects.toThrow(/user declined/);
  });

  it("throws guidance when Freighter is unavailable (Albedo-only)", async () => {
    mockIsConnected.mockResolvedValue({ isConnected: false });
    await expect(signTransaction("UNSIGNED_XDR", ADDR)).rejects.toThrow(/Freighter/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/stellar/__tests__/wallet.test.ts -t "signTransaction"`
Expected: FAIL — `signTransaction is not a function`.

- [ ] **Step 3: Implement `signTransaction`**

Add to `lib/stellar/wallet.ts` (after `signOwnership`). Import `networkPassphrase`:

```typescript
import { networkPassphrase } from "./config";
```

```typescript
/**
 * Co-sign a server-built transaction XDR with the connected wallet and return the
 * signed XDR. Used for the ST-4e sponsored-trustline flow: the platform has
 * already signed as sponsor; the recipient adds their signature here. Freighter
 * only — Albedo stays connect-only (no server-orchestrated signing path yet), so
 * it throws the same guidance as `signOwnership`.
 *
 * @param xdr             The platform-signed transaction envelope (base64 XDR).
 * @param expectedAddress The G… address whose signature is required; the wallet
 *                        signer must match it exactly (case-sensitive).
 */
export async function signTransaction(
  xdr: string,
  expectedAddress: string,
): Promise<string> {
  assertAddress(expectedAddress);

  if (!(await isFreighterAvailable())) {
    throw new Error(
      "Albedo cannot co-sign a sponsored trustline server-side yet. " +
        "Install Freighter to set up USDC payouts.",
    );
  }

  const { signTransaction: freighterSign } = await import("@stellar/freighter-api");
  const res = await freighterSign(xdr, {
    address: expectedAddress,
    networkPassphrase: networkPassphrase(),
  });
  if (res.error) throw new Error(`Freighter signing failed: ${res.error.message}`);
  if (res.signerAddress !== expectedAddress) {
    throw new Error(
      `Signed with the wrong account: expected ${expectedAddress}, got ${res.signerAddress}.`,
    );
  }
  return res.signedTxXdr;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/stellar/__tests__/wallet.test.ts -t "signTransaction"`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add lib/stellar/wallet.ts lib/stellar/__tests__/wallet.test.ts
git commit -m "feat(stellar): ST-4e — Freighter signTransaction wallet path (#314)"
```

---

### Task 4: `/api/me/wallet/sponsor` route — build (GET) + submit (POST)

**Files:**
- Create: `app/api/me/wallet/sponsor/route.ts`
- Test: `app/api/me/wallet/sponsor/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `getLabelerSession`, `requireLabelerSession` (`@/lib/labeler-auth`); `isValidStellarAddress` (`@/lib/stellar/signature`); `accountHasUsdcTrustline`, `buildSponsoredTrustlineTx`, `submitSponsoredTrustline`, `StellarPaymentError` (`@/lib/stellar/client`); `checkWalletRateLimit` (`@/lib/rate-limit`); `Sentry`.
- Produces: `GET(req)` → `{ needed:false }` or `{ needed:true, xdr, kind }`; `POST(req)` → `{ established:true }` or error bodies.

- [ ] **Step 1: Write the failing tests**

Mirror `app/api/me/wallet/__tests__/route.test.ts`'s hoisted-mock style. Create `app/api/me/wallet/sponsor/__tests__/route.test.ts`:

```typescript
import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";

const {
  mockGetSession, mockHasTrustline, mockBuild, mockSubmit, mockRateLimit,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockHasTrustline: vi.fn(),
  mockBuild: vi.fn(),
  mockSubmit: vi.fn(),
  mockRateLimit: vi.fn(),
}));

vi.mock("@/lib/labeler-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/labeler-auth")>();
  return { ...actual, getLabelerSession: mockGetSession };
});
vi.mock("@/lib/stellar/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar/client")>();
  return {
    ...actual,
    accountHasUsdcTrustline: mockHasTrustline,
    buildSponsoredTrustlineTx: mockBuild,
    submitSponsoredTrustline: mockSubmit,
  };
});
vi.mock("@/lib/rate-limit", () => ({ checkWalletRateLimit: mockRateLimit }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import { GET, POST } from "../route";
import { StellarPaymentError } from "@/lib/stellar/client";

const ADDR = Keypair.random().publicKey();

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue("user-1");
  mockRateLimit.mockResolvedValue(false);
});

function getReq(address: string) {
  return new NextRequest(`http://localhost/api/me/wallet/sponsor?address=${encodeURIComponent(address)}`);
}
function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/me/wallet/sponsor", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("GET /api/me/wallet/sponsor", () => {
  it("401 without a session", async () => {
    mockGetSession.mockResolvedValue(null);
    expect((await GET(getReq(ADDR))).status).toBe(401);
  });
  it("400 on an invalid address", async () => {
    expect((await GET(getReq("not-a-key"))).status).toBe(400);
  });
  it("returns needed:false when a trustline already exists", async () => {
    mockHasTrustline.mockResolvedValue(true);
    const body = await (await GET(getReq(ADDR))).json();
    expect(body).toEqual({ needed: false });
    expect(mockBuild).not.toHaveBeenCalled();
  });
  it("returns the sponsored xdr + kind when no trustline", async () => {
    mockHasTrustline.mockResolvedValue(false);
    mockBuild.mockResolvedValue({ xdr: "XDR", kind: "trustline" });
    const body = await (await GET(getReq(ADDR))).json();
    expect(body).toEqual({ needed: true, xdr: "XDR", kind: "trustline" });
  });
});

describe("POST /api/me/wallet/sponsor", () => {
  it("400 on an invalid address", async () => {
    expect((await POST(postReq({ address: "x", signedXdr: "X" }))).status).toBe(400);
  });
  it("establishes the trustline", async () => {
    mockSubmit.mockResolvedValue({ hash: "H" });
    const res = await POST(postReq({ address: ADDR, signedXdr: "SIGNED" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ established: true });
  });
  it("503 sponsorship_unavailable on op_low_reserve", async () => {
    mockSubmit.mockRejectedValue(new StellarPaymentError("x", "op_low_reserve", false));
    const res = await POST(postReq({ address: ADDR, signedXdr: "SIGNED" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("sponsorship_unavailable");
  });
  it("409 retry on tx_bad_seq", async () => {
    mockSubmit.mockRejectedValue(new StellarPaymentError("x", "tx_bad_seq", true));
    const res = await POST(postReq({ address: ADDR, signedXdr: "SIGNED" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("retry");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/api/me/wallet/sponsor/__tests__/route.test.ts`
Expected: FAIL — cannot resolve `../route`.

- [ ] **Step 3: Implement the route**

Create `app/api/me/wallet/sponsor/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getLabelerSession, requireLabelerSession } from "@/lib/labeler-auth";
import { isValidStellarAddress } from "@/lib/stellar/signature";
import {
  accountHasUsdcTrustline,
  buildSponsoredTrustlineTx,
  submitSponsoredTrustline,
  StellarPaymentError,
} from "@/lib/stellar/client";
import { checkWalletRateLimit } from "@/lib/rate-limit";

/**
 * ST-4e (#314) — platform-sponsored USDC trustlines (CAP-33).
 *
 *   GET  ?address → { needed:false } if the address already trusts USDC, else
 *                   { needed:true, xdr, kind } — a platform-signed sponsored
 *                   `changeTrust` (+ `createAccount` if the account is unfunded)
 *                   for the wallet to co-sign.
 *   POST { address, signedXdr } → submit the recipient-co-signed tx; the labeler
 *                   pays 0 XLM (the platform sponsors the reserves).
 *
 * Replaces ST-4b's hard `no_trustline` reject with an in-app funded flow. StrKey
 * is case-sensitive — the address is never lowercased.
 */
export async function GET(req: NextRequest) {
  const userId = await getLabelerSession(req);
  const unauthorized = requireLabelerSession(userId);
  if (unauthorized) return unauthorized;

  const address = req.nextUrl.searchParams.get("address");
  if (!address || !isValidStellarAddress(address)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }

  // Same limiter the link GET uses — bound sponsored-tx build churn per address.
  if (await checkWalletRateLimit(address)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  try {
    if (await accountHasUsdcTrustline(address)) {
      return NextResponse.json({ needed: false });
    }
    const { xdr, kind } = await buildSponsoredTrustlineTx(address);
    return NextResponse.json({ needed: true, xdr, kind });
  } catch (err) {
    Sentry.captureException(err, { extra: { context: "sponsor-trustline-build", userId } });
    return NextResponse.json({ error: "build_failed" }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const userId = await getLabelerSession(req);
  const unauthorized = requireLabelerSession(userId);
  if (unauthorized) return unauthorized;

  let body: { address?: unknown; signedXdr?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const address = typeof body.address === "string" ? body.address : "";
  const signedXdr = typeof body.signedXdr === "string" ? body.signedXdr : "";
  if (!isValidStellarAddress(address)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }
  if (!signedXdr) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    await submitSponsoredTrustline(signedXdr);
    return NextResponse.json({ established: true });
  } catch (err) {
    if (err instanceof StellarPaymentError) {
      if (err.code === "tx_bad_seq") {
        return NextResponse.json({ error: "retry" }, { status: 409 });
      }
      if (err.code === "op_low_reserve") {
        return NextResponse.json({ error: "sponsorship_unavailable" }, { status: 503 });
      }
      if (err.code === "invalid_sponsor_tx") {
        return NextResponse.json({ error: "invalid_sponsor_tx" }, { status: 400 });
      }
    }
    Sentry.captureException(err, { extra: { context: "sponsor-trustline-submit", userId } });
    return NextResponse.json({ error: "submit_failed" }, { status: 502 });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/api/me/wallet/sponsor/__tests__/route.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add app/api/me/wallet/sponsor/route.ts app/api/me/wallet/sponsor/__tests__/route.test.ts
git commit -m "feat(stellar): ST-4e — /api/me/wallet/sponsor build+submit route (#314)"
```

---

### Task 5: Wire the sponsored flow into `StellarWalletLink`

**Files:**
- Modify: `components/StellarWalletLink.tsx`

**Interfaces:**
- Consumes: `connect`, `signOwnership`, `signTransaction` (`@/lib/stellar/wallet`); the `/api/me/wallet/sponsor` GET/POST and existing `/api/me/wallet` GET/POST.
- Produces: unchanged component props (`isLinked`, `onLinked`, `showToast`).

- [ ] **Step 1: Add an `ensureTrustline` step before the challenge in `handleLink`**

There is no unit test for this component in the repo (client component, wallet-driven); it is covered by the route tests above and manual/testnet E2E in Task 7. Modify `components/StellarWalletLink.tsx`. Add `signTransaction` to the import:

```typescript
import { connect, signOwnership, signTransaction } from "@/lib/stellar/wallet";
```

Add this helper inside the component (above `handleLink`):

```typescript
  /**
   * Ensure `address` holds a USDC trustline, sponsoring it (CAP-33) if not. The
   * labeler pays 0 XLM. Returns true when the address is ready to receive USDC,
   * false when the caller should abort (a toast has already been shown). One
   * retry on the tx_bad_seq race (a concurrent payout took the platform's
   * sequence — rebuild + re-sign).
   */
  const ensureTrustline = async (address: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(
        `/api/me/wallet/sponsor?address=${encodeURIComponent(address)}`,
      );
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error ?? "Could not set up USDC payouts", "error");
        return false;
      }
      if (!data.needed) return true; // already trusts USDC

      const signedXdr = await signTransaction(data.xdr, address);
      const submit = await fetch("/api/me/wallet/sponsor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, signedXdr }),
      });
      if (submit.ok) return true;

      const err = await submit.json();
      if (submit.status === 409 && err.error === "retry") continue; // rebuild + re-sign
      if (submit.status === 503) {
        showToast("Payouts are temporarily unavailable. Please try again shortly.", "error");
        return false;
      }
      showToast(err.error ?? "Could not set up USDC payouts", "error");
      return false;
    }
    showToast("Could not set up USDC payouts. Please try again.", "error");
    return false;
  };
```

- [ ] **Step 2: Call `ensureTrustline` in `handleLink` between connect and the challenge**

Replace the body of `handleLink`'s `try` block from step 1 (the `connect()` call) through the challenge fetch so the sponsor step runs first:

```typescript
    try {
      // 1. Connect a wallet and read its `G…` address (never normalized).
      const { address } = await connect();

      // 2. Ensure the address can receive USDC — sponsor its trustline if needed
      //    (labeler pays 0 XLM). Replaces ST-4b's hard no-trustline reject.
      if (!(await ensureTrustline(address))) return;

      // 3. Fetch a one-time, server-issued challenge bound to this address.
      const challengeRes = await fetch(
        `/api/me/wallet?address=${encodeURIComponent(address)}`,
      );
```

Renumber the remaining comments (`4.`, `5.`) accordingly. The existing `no_trustline` 409 branch in `handleLink` stays as a final guard (it should no longer fire on the happy path).

- [ ] **Step 3: Typecheck + lint the component**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add components/StellarWalletLink.tsx
git commit -m "feat(stellar): ST-4e — sponsored-trustline step in wallet link UX (#314)"
```

---

### Task 6: Wallet-health XLM floor budgets sponsored reserves

**Files:**
- Modify: `lib/stellar/balance.ts`
- Modify: `app/api/health/wallet/route.ts`
- Test: `lib/stellar/__tests__/balance.test.ts`

**Interfaces:**
- Consumes: Horizon `account.num_sponsoring` (number on the loaded account record); existing `extractBalances`, `evaluateThresholds`, `parseBalanceThresholds`.
- Produces: `WalletHealth.numSponsoring: number`, `WalletHealth.sponsoredReserveXlm: string`; `getWalletHealth` subtracts `0.5 × num_sponsoring` from XLM before threshold evaluation.

- [ ] **Step 1: Write the failing test**

Add to `lib/stellar/__tests__/balance.test.ts`. The existing tests mock `loadAccount`; extend a `getWalletHealth` case with `num_sponsoring`:

```typescript
import { TRUSTLINE_RESERVE_XLM } from "../balance";

describe("getWalletHealth sponsored-reserve accounting", () => {
  it("subtracts 0.5 XLM per num_sponsoring from the XLM floor", async () => {
    // 6 XLM raw, but 10 sponsored trustlines lock 5 XLM → 1 XLM available,
    // which is at/below the default page threshold (2 XLM) → pages.
    mockLoadAccount.mockResolvedValue({
      num_sponsoring: 10,
      balances: [
        { asset_type: "native", balance: "6.0000000" },
        { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "100.0" },
      ],
    });
    const health = await getWalletHealth();
    expect(TRUSTLINE_RESERVE_XLM).toBe(0.5);
    expect(health.numSponsoring).toBe(10);
    expect(health.sponsoredReserveXlm).toBe("5.0000");
    expect(health.healthy).toBe(false);
    expect(health.pages.join(" ")).toMatch(/XLM/);
  });

  it("treats a missing num_sponsoring as 0", async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [{ asset_type: "native", balance: "50.0" }],
    });
    const health = await getWalletHealth();
    expect(health.numSponsoring).toBe(0);
    expect(health.sponsoredReserveXlm).toBe("0.0000");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/stellar/__tests__/balance.test.ts -t "sponsored-reserve"`
Expected: FAIL — `TRUSTLINE_RESERVE_XLM` undefined / `numSponsoring` missing.

- [ ] **Step 3: Implement in `balance.ts`**

Add the constant near the top:

```typescript
/** XLM reserve locked on the sponsor per sponsored trustline (Stellar base reserve × 1). */
export const TRUSTLINE_RESERVE_XLM = 0.5;
```

Add `num_sponsoring` to the account-record type read, and two fields to `WalletHealth`:

```typescript
export interface WalletHealth {
  address: string;
  usdcBalance: string;
  xlmBalance: string;
  /** Count of trustlines the platform is sponsoring (Horizon num_sponsoring). */
  numSponsoring: number;
  /** XLM locked by those sponsorships (0.5 × numSponsoring), informational. */
  sponsoredReserveXlm: string;
  rewardTokenSymbol: string;
  healthy: boolean;
  warnings: string[];
  pages: string[];
  thresholds: BalanceThresholds;
}
```

In `getWalletHealth`, after loading the account, read `num_sponsoring` and compute available XLM. Replace the load + evaluate block:

```typescript
  let xlm = 0;
  let usdc = 0;
  let numSponsoring = 0;
  try {
    const account = await server().loadAccount(address);
    ({ xlm, usdc } = extractBalances(account.balances as HorizonBalanceLine[]));
    numSponsoring = Number((account as { num_sponsoring?: number }).num_sponsoring ?? 0);
  } catch {
    return {
      address,
      usdcBalance: "—",
      xlmBalance: "—",
      numSponsoring: 0,
      sponsoredReserveXlm: "0.0000",
      rewardTokenSymbol: REWARD_TOKEN_SYMBOL,
      healthy: false,
      warnings: ["STELLAR_PLATFORM_SECRET not configured or Horizon unavailable"],
      pages: [],
      thresholds,
    };
  }

  // Sponsored reserves are locked on the platform account — subtract them so the
  // XLM floor reflects *available* fee XLM, not reserves the platform can't spend
  // (ST-4e #314). USDC float is unaffected.
  const sponsoredReserveXlm = TRUSTLINE_RESERVE_XLM * numSponsoring;
  const availableXlm = xlm - sponsoredReserveXlm;

  const { healthy, warnings, pages } = evaluateThresholds(availableXlm, usdc, thresholds);

  return {
    address,
    usdcBalance: usdc.toFixed(4),
    xlmBalance: xlm.toFixed(4),
    numSponsoring,
    sponsoredReserveXlm: sponsoredReserveXlm.toFixed(4),
    rewardTokenSymbol: REWARD_TOKEN_SYMBOL,
    healthy,
    warnings,
    pages,
    thresholds,
  };
```

Also update the early "no address" return to include the two new fields:

```typescript
  if (!address) {
    return {
      address: "—",
      usdcBalance: "—",
      xlmBalance: "—",
      numSponsoring: 0,
      sponsoredReserveXlm: "0.0000",
      rewardTokenSymbol: REWARD_TOKEN_SYMBOL,
      healthy: false,
      warnings: ["STELLAR_PLATFORM_SECRET not configured"],
      pages: [],
      thresholds,
    };
  }
```

Delete the stale ST-4e TODO comment in `parseBalanceThresholds` (the `NOTE (ST-4e #314): …` block, `balance.ts:66`), replacing it with:

```typescript
    // XLM floor covers fees + the account's base reserve + every trustline
    // reserve. Sponsored recipient trustlines are subtracted from the balance in
    // getWalletHealth (ST-4e #314), so this threshold stays fee-oriented.
```

- [ ] **Step 4: Surface the new fields in the health route**

Modify `app/api/health/wallet/route.ts` to include them:

```typescript
  return NextResponse.json({
    usdcBalance: health.usdcBalance,
    rewardTokenSymbol: health.rewardTokenSymbol,
    xlmBalance: health.xlmBalance,
    numSponsoring: health.numSponsoring,
    sponsoredReserveXlm: health.sponsoredReserveXlm,
    healthy: health.healthy,
    warnings: health.warnings,
    pages: health.pages,
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run lib/stellar/__tests__/balance.test.ts`
Expected: PASS (old + new). If any existing `getWalletHealth` test asserts the full object shape, add `numSponsoring`/`sponsoredReserveXlm` to its expectation.

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc --noEmit
git add lib/stellar/balance.ts app/api/health/wallet/route.ts lib/stellar/__tests__/balance.test.ts
git commit -m "feat(stellar): ST-4e — wallet-health budgets sponsored-reserve XLM (#314)"
```

---

### Task 7: Full-suite verification + roadmap/issue update

**Files:**
- Modify: none (verification) — plus roadmap #289 / issue #314 via `gh`.

- [ ] **Step 1: Run the full stellar + wallet suites**

Run: `npx vitest run lib/stellar app/api/me/wallet app/api/health`
Expected: all PASS, no todo regressions.

- [ ] **Step 2: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Grep for accidental normalization / viem regressions**

Run: `git grep -nE "toLowerCase" lib/stellar app/api/me/wallet`
Expected: no `G…`/wallet address is lowercased (EMAIL-only matches acceptable elsewhere, but none in these paths).

Run: `git grep -nE "formatUnits|parseUnits|viem" lib/stellar app/api/me/wallet/sponsor`
Expected: no matches.

- [ ] **Step 4: Manual testnet smoke (documented, gated)**

This is the ST-4e acceptance path and the one item requiring a live network; record the result in the PR description rather than automating here. With `STELLAR_NETWORK=testnet`, a funded platform account (XLM + USDC trustline + USDC float), and a **brand-new 0-XLM** Freighter account:
1. Log in (email/password), accrue a USDC balance, open the withdrawal screen.
2. Link payout wallet → confirm the "Set up USDC payouts" step prompts a Freighter signature and submits (verify the sponsored `changeTrust` [+ `createAccount`] on stellar.expert; the labeler account shows a USDC trustline with the reserve sponsored by the platform).
3. Withdraw a lump sum → confirm the USDC payment on stellar.expert.
4. Check `/api/health/wallet` reports `numSponsoring ≥ 1` and the XLM floor reflects it.

Note explicitly if Freighter refused to sign for the unfunded account (the one flagged testnet risk) — that would gate the account-creation branch.

- [ ] **Step 5: Commit any doc notes, then update the roadmap**

Update issue #314 (mark scope items done) and roadmap #289 (flip ST-4e ⬜ → ✅ once merged, adjust progress to 20/23). Per repo convention, edit the #289 body in place; do not add a comment to #289.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feat/stellar-4e-sponsored-trustlines
gh pr create --base stellar --title "ST-4e — sponsored USDC trustlines (CAP-33) (#314)" --body "<summary + testnet smoke result>"
```

---

## Notes for the implementer

- The `require("@stellar/stellar-sdk")` calls inside Task 2's test helpers are only to keep helper scope local; you may hoist a top-level `import { TransactionBuilder, Asset, Operation } from "@stellar/stellar-sdk"` instead — match whichever the existing test file already imports.
- `TransactionBuilder.fromXDR` returns `Transaction | FeeBumpTransaction`. We only ever build plain `Transaction`s, so `.operations` is present; narrow with a cast if `tsc` objects (see Task 2 note).
- Freighter's `signTransaction` return field is `signedTxXdr` (not `signedXdr`) and it also returns `signerAddress` — asserted in Task 3.
- Do not add a DB table — sponsorship liability is derived live from Horizon `num_sponsoring` (locked decision).

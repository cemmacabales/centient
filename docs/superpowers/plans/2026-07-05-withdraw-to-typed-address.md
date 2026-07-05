# Withdraw to a Typed Recipient Address — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every withdrawal ask for the recipient's Stellar address, typed fresh each time (paste-and-send), instead of auto-sending to a once-linked wallet.

**Architecture:** `POST /api/me/withdraw` accepts `{ destinationAddress }` in the body, validates the `G…` StrKey, runs the existing fraud/eligibility gates and USDC-trustline precheck against that typed address, then enqueues the payout to it. `GET` drops `walletLinked`. `AccountSheet.tsx` gains a "Recipient Stellar address" field plus a confirm step and drops the `StellarWalletLink` block. The SEP-53 link route and sponsored-trustline route are left in the repo but unreferenced by this path.

**Tech Stack:** Next.js 16 (app router, route handlers), TypeScript, Prisma 7, Vitest, `@stellar/stellar-sdk`, React 19.

## Global Constraints

- Trunk is `stellar` (permanent; **never** merged to `develop`). Work on branch `feat/stellar-withdraw-typed-address`.
- Stellar `G…` addresses are **case-sensitive StrKey** — never `.toLowerCase()`/normalize them.
- Reward asset is USDC at **7 decimals** (1 USDC = 10^7 units).
- Reject-and-guidance on missing trustline; do **not** offer the sponsored-trustline flow on this path.
- No ownership proof (no Freighter signature) and no persistence of the typed address on the user row.
- Run tests with `pnpm test <path>`; typecheck with `pnpm typecheck`.

---

### Task 1: Backend — `POST /api/me/withdraw` accepts a typed `destinationAddress`

**Files:**
- Modify: `app/api/me/withdraw/route.ts` (the `POST` handler, lines 37–241)
- Test: `app/api/me/withdraw/__tests__/route.test.ts` (the `describe("POST …")` block)

**Interfaces:**
- Consumes: `enqueueWithdrawal(userId: string, walletAddress: string, minUnits: bigint): Promise<{ payoutJobId: string; amountUnits: bigint }>` from `@/lib/user-balance`; `isValidStellarAddress(addr: string): boolean` from `@/lib/stellar/signature`; `accountHasUsdcTrustline(addr: string): Promise<boolean>` from `@/lib/stellar/client`.
- Produces: `POST` now reads `{ destinationAddress: string }` from the request body and returns `{ status, withdrawalId, amountUnits, destinationAddress, token }` on success. New error bodies: `400 missing_address`, plus `invalid_wallet`/`no_trustline` now keyed off the typed address.

- [ ] **Step 1: Update the POST test harness and rewrite the address-dependent tests**

In `app/api/me/withdraw/__tests__/route.test.ts`, replace the `makeReq` helper (lines 39–41) so a POST carries a JSON body with the destination address (default a valid `G…`), and `undefined` sends no body:

```ts
function makeReq(destinationAddress: string | undefined = G_WALLET): NextRequest {
  return new NextRequest("http://localhost/api/me/withdraw", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: destinationAddress === undefined ? undefined : JSON.stringify({ destinationAddress }),
  });
}
```

Replace the "no linked wallet" test (lines 82–90) with a missing-address test:

```ts
  it("returns 400 missing_address when no destination address is supplied", async () => {
    const user = await createUser({ pendingBalanceUnits: 5000000000000000000n });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);
    const res = await POST(makeReq(undefined));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_address" });
  });
```

Replace the queue happy-path assertion on `destinationAddress` (line 114) so it checks the typed address rather than a linked wallet:

```ts
    expect(body.destinationAddress).toBe(G_WALLET);
```

Replace the "invalid_wallet" test (lines 131–144) so the malformed address arrives in the body:

```ts
  it("returns 400 invalid_wallet when the destination is not a valid StrKey", async () => {
    const user = await createUser({ pendingBalanceUnits: 5000000000000000000n });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);

    const res = await POST(makeReq(makeWallet())); // legacy 0x… — not a Stellar G…

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_wallet" });
    expect(await prisma.payoutJob.count({ where: { userId: user.id } })).toBe(0);
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after?.pendingBalanceUnits).toBe(5000000000000000000n);
  });
```

In the wallet-ban test (lines 313–331), ban `G_WALLET` and pass it as the destination; assert against `G_WALLET`:

```ts
  it("returns 403 when the destination wallet is banned", async () => {
    const user = await createUser({ pendingBalanceUnits: 5000000000000000000n });
    await prisma.bannedIdentity.create({
      data: { identifierType: "WALLET", identifierValue: G_WALLET, reason: "wallet ban" },
    });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);

    const res = await POST(makeReq(G_WALLET));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("identity_banned");
    expect(body.identifierType).toBe("WALLET");
    expect(body.identifierValue).toBe(G_WALLET);
  });
```

In the shared-wallet block-test (lines 369–405), the abuser's destination must match the seeded jobs' `destinationAddress`. Seed jobs with `G_SHARED` and call `makeReq(G_SHARED)`:

```ts
  it("returns 403 when the destination wallet has received from too many accounts", async () => {
    const sharedWallet = G_SHARED;
    const users = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        createUser({ walletAddress: G_USERS[i], pendingBalanceUnits: 5000000000000000000n }),
      ),
    );
    for (const user of users) {
      await prisma.payoutJob.create({
        data: {
          type: "WITHDRAWAL",
          userId: user.id,
          amountUnits: 1000000000000000000n,
          destinationAddress: sharedWallet,
          status: "done",
        },
      });
    }
    const abuser = await createUser({ pendingBalanceUnits: 5000000000000000000n });
    vi.mocked(getLabelerSession).mockResolvedValue(abuser.id);

    const res = await POST(makeReq(sharedWallet));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("shared_wallet_detected");
    expect(body.walletAddress).toBe(sharedWallet);
    expect(body.accountCount).toBe(3);
  });
```

In the "below threshold" shared-wallet test (lines 407–442), just call `makeReq(G_WALLET)` (the seeded `0x` jobs stay below threshold and no longer match the `G…` destination):

```ts
    const newUser = await createUser({ pendingBalanceUnits: 5000000000000000000n });
    vi.mocked(getLabelerSession).mockResolvedValue(newUser.id);

    const res = await POST(makeReq(G_WALLET));

    expect(res.status).toBe(200);
```

In the SHARED_WALLET flag test (lines 466–500), seed with `G_SHARED` and call `makeReq(G_SHARED)`:

```ts
  it("records a SHARED_WALLET flag when a shared wallet is blocked", async () => {
    const sharedWallet = G_SHARED;
    const users = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        createUser({ walletAddress: G_USERS[i], pendingBalanceUnits: 5000000000000000000n }),
      ),
    );
    for (const u of users) {
      await prisma.payoutJob.create({
        data: {
          type: "WITHDRAWAL",
          userId: u.id,
          amountUnits: 1000000000000000000n,
          destinationAddress: sharedWallet,
          status: "done",
        },
      });
    }
    const abuser = await createUser({ pendingBalanceUnits: 5000000000000000000n });
    vi.mocked(getLabelerSession).mockResolvedValue(abuser.id);

    const res = await POST(makeReq(sharedWallet));
    expect(res.status).toBe(403);

    const flags = await prisma.flaggedWithdrawal.findMany({ where: { userId: abuser.id } });
    expect(flags).toHaveLength(1);
    expect(flags[0].reason).toBe("SHARED_WALLET");
    expect((flags[0].detail as Record<string, unknown>).accountCount).toBe(3);
  });
```

Add a dedicated no-trustline test right after the existing 409 test (keep the existing one too, it still passes with the default `G_WALLET`):

```ts
  it("returns 409 no_trustline for a typed address with no USDC trustline", async () => {
    const user = await createUser({ pendingBalanceUnits: 5000000000000000000n });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);
    vi.mocked(accountHasUsdcTrustline).mockResolvedValue(false);

    const res = await POST(makeReq(G_WALLET));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no_trustline");
    expect(await prisma.payoutJob.count({ where: { userId: user.id } })).toBe(0);
  });
```

> Note: the P4a eligibility tests and the remaining flag tests already pass a body via the new `makeReq()` default and don't assert on the destination — leave them unchanged. The `createUser({ walletAddress: … })` calls elsewhere are now irrelevant to the destination but harmless; leave them.

- [ ] **Step 2: Run the POST tests to confirm they fail against the current handler**

Run: `pnpm test app/api/me/withdraw/__tests__/route.test.ts -t "POST"`
Expected: FAIL — the current handler ignores the body, so `missing_address` / `invalid_wallet` (typed) / typed shared-wallet cases fail.

- [ ] **Step 3: Replace the `POST` handler to read and use the typed address**

In `app/api/me/withdraw/route.ts`, replace the entire `POST` function (lines 37–241) with:

```ts
export async function POST(req: NextRequest) {
  const userId = await getLabelerSession(req);
  const unauthorized = requireLabelerSession(userId);
  if (unauthorized) return unauthorized;

  const user = await prisma.user.findUnique({
    where: { id: userId! },
    select: {
      email: true,
      isBanned: true,
      submissionCount: true,
      goldCorrect: true,
      goldAttempted: true,
      createdAt: true,
      pendingBalanceUnits: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (user.isBanned) {
    return NextResponse.json({ error: "account_frozen" }, { status: 403 });
  }

  // Paste-and-send: the recipient Stellar address is supplied fresh in the body
  // on every withdrawal — no persistent linked wallet and no ownership proof.
  // This deliberately reverses the earlier "destination is never from the body"
  // rule (product decision, 2026-07-05 spec). A typo sends USDC irreversibly, so
  // the client shows a confirm step before calling this.
  const body = await req.json().catch(() => null);
  const destinationAddress =
    body && typeof body === "object"
      ? (body as { destinationAddress?: unknown }).destinationAddress
      : undefined;
  if (typeof destinationAddress !== "string" || !destinationAddress) {
    return NextResponse.json({ error: "missing_address" }, { status: 400 });
  }
  // StrKey is case-sensitive — never normalize. A malformed or legacy `0x…`
  // value can never receive USDC; reject before touching any balance.
  if (!isValidStellarAddress(destinationAddress)) {
    return NextResponse.json({ error: "invalid_wallet" }, { status: 400 });
  }

  // P4c — record blocked withdrawals for the admin queue. Best-effort; a failure
  // to record must never turn a clean 403 into a 500.
  const flag = (
    reason: "BANNED_IDENTITY" | "SHARED_WALLET" | "INELIGIBLE",
    detail: Record<string, unknown>,
  ) =>
    recordFlaggedWithdrawal({
      userId: userId!,
      walletAddress: destinationAddress,
      reason,
      detail: detail as never,
      balanceUnits: user.pendingBalanceUnits,
    }).catch((err) => {
      Sentry.captureException(err, { extra: { context: "flag-withdrawal", userId } });
    });

  // P4b — identity-based anti-fraud gates run against the typed destination.
  const banError = await isAnyIdentifierBanned(user.email, destinationAddress, userId!);
  if (banError) {
    await flag("BANNED_IDENTITY", {
      identifierType: banError.bannedIdentifierType,
      identifierValue: banError.identifierValue,
      reason: banError.reason,
    });
    return NextResponse.json(
      {
        error: "identity_banned",
        identifierType: banError.bannedIdentifierType,
        identifierValue: banError.identifierValue,
        reason: banError.reason,
      },
      { status: 403 },
    );
  }

  const sharedWalletError = await checkSharedWallet(destinationAddress, userId!);
  if (sharedWalletError) {
    await flag("SHARED_WALLET", {
      walletAddress: sharedWalletError.walletAddress,
      accountCount: sharedWalletError.accountCount,
    });
    return NextResponse.json(
      {
        error: "shared_wallet_detected",
        walletAddress: sharedWalletError.walletAddress,
        accountCount: sharedWalletError.accountCount,
      },
      { status: 403 },
    );
  }

  // P4a — quality/eligibility gates, checked before locking any balance.
  const eligibility = checkWithdrawalEligibility(
    {
      submissionCount: user.submissionCount,
      goldCorrect: user.goldCorrect,
      goldAttempted: user.goldAttempted,
      createdAt: user.createdAt,
    },
    getWithdrawalThresholds(),
  );
  if (!eligibility.eligible) {
    await flag("INELIGIBLE", {
      reason: eligibility.reason,
      required: eligibility.required,
      actual: eligibility.actual,
    });
    return NextResponse.json(
      {
        error: "not_eligible",
        reason: eligibility.reason,
        required: eligibility.required,
        actual: eligibility.actual,
      },
      { status: 403 },
    );
  }

  // USDC-trustline precheck on the typed address before locking any balance: an
  // untrusted address would fail the on-chain payout with `op_no_trust`. Reject
  // with guidance so the recipient adds the trustline in their own wallet.
  let hasTrustline: boolean;
  try {
    hasTrustline = await accountHasUsdcTrustline(destinationAddress);
  } catch (err) {
    Sentry.captureException(err, { extra: { context: "withdraw-trustline", userId } });
    return NextResponse.json({ error: "trustline_check_failed" }, { status: 502 });
  }
  if (!hasTrustline) {
    return NextResponse.json(
      {
        error: "no_trustline",
        message:
          "Your Stellar address has no USDC trustline yet. Add a USDC trustline in your wallet, then withdraw again.",
      },
      { status: 409 },
    );
  }

  try {
    const result = await enqueueWithdrawal(
      userId!,
      destinationAddress,
      getMinWithdrawalUnits(),
    );

    return NextResponse.json({
      status: "queued",
      withdrawalId: result.payoutJobId,
      amountUnits: result.amountUnits.toString(),
      destinationAddress,
      token: REWARD_TOKEN_SYMBOL,
    });
  } catch (err) {
    if (err instanceof BelowMinimumWithdrawalError) {
      return NextResponse.json(
        {
          error: "below_minimum",
          minimumUnits: err.minimumUnits.toString(),
          balanceUnits: err.balanceUnits.toString(),
        },
        { status: 400 },
      );
    }
    if (err instanceof WithdrawalInFlightError) {
      return NextResponse.json({ error: "withdrawal_in_flight" }, { status: 409 });
    }
    if (err instanceof BannedIdentityError) {
      await flag("BANNED_IDENTITY", {
        identifierType: err.bannedIdentifierType,
        identifierValue: err.identifierValue,
        reason: err.reason,
      });
      return NextResponse.json(
        {
          error: "identity_banned",
          identifierType: err.bannedIdentifierType,
          identifierValue: err.identifierValue,
          reason: err.reason,
        },
        { status: 403 },
      );
    }
    if (err instanceof SharedWalletError) {
      await flag("SHARED_WALLET", {
        walletAddress: err.walletAddress,
        accountCount: err.accountCount,
      });
      return NextResponse.json(
        {
          error: "shared_wallet_detected",
          walletAddress: err.walletAddress,
          accountCount: err.accountCount,
        },
        { status: 403 },
      );
    }
    Sentry.captureException(err, { extra: { context: "withdraw", userId } });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run the POST tests to confirm they pass**

Run: `pnpm test app/api/me/withdraw/__tests__/route.test.ts -t "POST"`
Expected: PASS (all POST tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/me/withdraw/route.ts app/api/me/withdraw/__tests__/route.test.ts
git commit -m "feat(stellar): withdraw POST takes a typed destination address

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Backend — `GET /api/me/withdraw` drops `walletLinked`

**Files:**
- Modify: `app/api/me/withdraw/route.ts` (the `GET` handler, lines 256–338)
- Test: `app/api/me/withdraw/__tests__/route.test.ts` (the `describe("GET …")` block)

**Interfaces:**
- Produces: `GET` response shape becomes `{ pendingBalanceUnits, thresholdUnits, canWithdraw, withdrawals[] }` — `walletLinked` removed. `canWithdraw = !isBanned && eligible && pendingBalanceUnits >= min && !hasInFlightWithdrawal`.

- [ ] **Step 1: Update the GET tests for the new shape**

In the GET block, rewrite the "no linked wallet" test (lines 563–576) — a user above the minimum with gates disabled can now withdraw, and `walletLinked` is gone:

```ts
  it("returns balance, threshold, empty history, and canWithdraw=true above the minimum", async () => {
    const user = await createUser({ pendingBalanceUnits: 5000000000000000000n });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);

    const res = await GET(makeGetReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      pendingBalanceUnits: "5000000000000000000",
      thresholdUnits: MIN,
      canWithdraw: true,
      withdrawals: [],
    });
    expect(body).not.toHaveProperty("walletLinked");
  });
```

Delete the legacy-`0x` test (lines 586–593) entirely — `walletLinked` no longer exists and the destination is validated at POST time.

In the eligible-`G…` test (lines 595–602), drop the `walletLinked` assertion:

```ts
  it("reports canWithdraw=true for an eligible user with enough balance", async () => {
    const user = await createUser({ pendingBalanceUnits: 5000000000000000000n });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);

    const body = await (await GET(makeGetReq())).json();
    expect(body.canWithdraw).toBe(true);
  });
```

In the in-flight test (lines 604–621), drop the `walletLinked` assertion, keep `canWithdraw=false`:

```ts
    const body = await (await GET(makeGetReq())).json();
    expect(body.canWithdraw).toBe(false);
```

- [ ] **Step 2: Run the GET tests to confirm they fail**

Run: `pnpm test app/api/me/withdraw/__tests__/route.test.ts -t "GET"`
Expected: FAIL — current handler still returns `walletLinked` and gates `canWithdraw` on a linked wallet.

- [ ] **Step 3: Update the `GET` handler**

In `app/api/me/withdraw/route.ts` `GET`, drop `walletAddress` from the `select` (lines 262–272 → remove the `walletAddress: true,` line). Then replace the `walletLinked`/`canWithdraw`/response block (lines 311–337) with:

```ts
  const canWithdraw =
    !user.isBanned &&
    eligibility.eligible &&
    user.pendingBalanceUnits >= minUnits &&
    !hasInFlightWithdrawal;

  return NextResponse.json({
    pendingBalanceUnits: user.pendingBalanceUnits.toString(),
    thresholdUnits: minUnits.toString(),
    canWithdraw,
    withdrawals: jobs.map((j) => ({
      id: j.id,
      amountUnits: (j.amountUnits ?? 0n).toString(),
      status: j.status,
      txHash: j.txHash,
      createdAt: j.createdAt.toISOString(),
      completedAt: j.completedAt ? j.completedAt.toISOString() : null,
      error: j.lastError,
    })),
  });
```

(Removes the `walletLinked` const and its comment block at lines 311–314.)

- [ ] **Step 4: Run the GET tests to confirm they pass**

Run: `pnpm test app/api/me/withdraw/__tests__/route.test.ts`
Expected: PASS (entire file — POST and GET).

- [ ] **Step 5: Commit**

```bash
git add app/api/me/withdraw/route.ts app/api/me/withdraw/__tests__/route.test.ts
git commit -m "feat(stellar): withdraw GET drops walletLinked; canWithdraw no longer needs a linked wallet

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — address field + confirm step in `AccountSheet.tsx`

**Files:**
- Modify: `components/AccountSheet.tsx`

**Interfaces:**
- Consumes: `GET /api/me/withdraw` (now without `walletLinked`); `POST /api/me/withdraw` with body `{ destinationAddress }`; `isValidStellarAddress` from `@/lib/stellar/signature` (already imported).
- Produces: no exported-interface change; internal UI only.

- [ ] **Step 1: Remove the `StellarWalletLink` import and the `walletLinked` field**

Delete line 8 (`import StellarWalletLink …`). In the `WithdrawalData` interface (lines 61–67), remove the `walletLinked: boolean;` line.

- [ ] **Step 2: Add address + confirm state**

After the `withdrawing` state (line 106) add:

```tsx
  const [payoutAddress, setPayoutAddress] = useState("");
  const [confirming, setConfirming] = useState(false);
```

- [ ] **Step 3: Rewrite `handleWithdraw` to send the typed address behind a confirm step**

Replace `handleWithdraw` (lines 142–162) with:

```tsx
  const addressValid = isValidStellarAddress(payoutAddress.trim());

  const submitWithdraw = async () => {
    setConfirming(false);
    setWithdrawing(true);
    try {
      const res = await fetch("/api/me/withdraw", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ destinationAddress: payoutAddress.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        showToast(`Withdrawal initiated: ${formatTokenBalance(data.amountUnits)} ${rewardSymbol}`, "success");
        const updated = await fetch("/api/me/withdraw")
          .then((r) => (r.ok ? r.json() : Promise.reject(r)))
          .catch(() => null);
        if (updated) setWithdrawalData(updated);
      } else {
        showToast(data.message || data.error || "Withdrawal failed", "error");
      }
    } catch {
      showToast("Withdrawal failed", "error");
    } finally {
      setWithdrawing(false);
    }
  };

  const handleWithdraw = () => {
    if (!withdrawalData?.canWithdraw || withdrawing || !addressValid) return;
    setConfirming(true);
  };
```

- [ ] **Step 4: Replace the Withdraw button + `StellarWalletLink` block with the address field and confirm UI**

Replace the button + `<StellarWalletLink …/>` block (lines 257–278) with:

```tsx
          <input
            type="text"
            value={payoutAddress}
            onChange={(e) => setPayoutAddress(e.target.value)}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="Recipient Stellar address (G…)"
            aria-label="Recipient Stellar address"
            className="mt-3 w-full rounded-xl bg-surface-container-low px-3 py-2 font-mono text-xs text-on-surface placeholder:text-outline focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          />
          {payoutAddress.trim() && !addressValid && (
            <p className="mt-1 font-body text-[11px] text-error">
              Enter a valid Stellar address (starts with G).
            </p>
          )}
          {confirming ? (
            <div className="mt-3 w-full rounded-xl bg-surface-container-low p-3 text-center">
              <p className="font-body text-xs text-on-surface">
                Send{" "}
                <strong>
                  {withdrawalData ? formatTokenBalance(withdrawalData.pendingBalanceUnits) : "—"} {rewardSymbol}
                </strong>{" "}
                to
              </p>
              <p className="mt-1 break-all font-mono text-[11px] text-on-surface-variant">
                {payoutAddress.trim()}
              </p>
              <p className="mt-1 font-body text-[10px] text-error">
                This is irreversible. Double-check the address.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={withdrawing}
                  className="flex-1 rounded-xl bg-surface-container-high px-4 py-2 font-label text-sm font-semibold text-on-surface-variant transition-colors hover:bg-surface-container-highest disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitWithdraw}
                  disabled={withdrawing}
                  className="flex-1 rounded-xl bg-primary px-4 py-2 font-label text-sm font-semibold text-on-primary transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {withdrawing ? "Sending..." : "Confirm & send"}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleWithdraw}
              disabled={loadingWithdrawal || !withdrawalData?.canWithdraw || withdrawing || !addressValid}
              className="mt-3 rounded-xl bg-primary px-6 py-2 font-label text-sm font-semibold text-on-primary transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-50"
            >
              Withdraw
            </button>
          )}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS — no reference to `StellarWalletLink` or `walletLinked` remains; `payoutAddress`/`confirming`/`addressValid` all resolve.

- [ ] **Step 6: Manual verification in the running app**

`AccountSheet.tsx` has no unit-test file; verify in the browser. With the dev server up (`pnpm dev`) and a labeler logged in with a pending balance ≥ the minimum:
1. Open the account sheet → the "Recipient Stellar address (G…)" field is present; the Withdraw button is disabled until a valid `G…` is entered.
2. Type a malformed value → inline "Enter a valid Stellar address" appears, button stays disabled.
3. Paste a valid testnet `G…` (with a USDC trustline) → Withdraw enables → click → confirm card shows amount + address → "Confirm & send" → success toast; a queued withdrawal appears in "Recent withdrawals".
4. Paste a valid `G…` **without** a trustline → confirm → the `no_trustline` guidance shows as an error toast; no withdrawal queued.

- [ ] **Step 7: Commit**

```bash
git add components/AccountSheet.tsx
git commit -m "feat(stellar): AccountSheet asks for the payout address each withdrawal with a confirm step

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes / follow-ups (out of scope for this plan)

- `components/StellarWalletLink.tsx`, `app/api/me/wallet/route.ts`, and `app/api/me/wallet/sponsor/route.ts` are now unreferenced by the withdrawal path but left in the repo (their own tests still pass). A later cleanup can remove them if the paste-and-send model sticks.
- `user.walletAddress` is no longer written by this path; admin wallet lookups (ST-5b) are unaffected and unchanged.
- Demo-env wiring (`.env.local` Stellar block, platform-account faucet) is tracked separately from this change.

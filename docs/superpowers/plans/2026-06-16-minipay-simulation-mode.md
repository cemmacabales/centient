# MiniPay Simulation Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-dev-only mode that simulates running inside MiniPay end-to-end — login and payout — with no MetaMask, no MiniPay account, and no Celo network connection.

**Architecture:** A single gate `isSimulationMode()` (env flag `NEXT_PUBLIC_SIMULATE_MINIPAY=1` AND `NODE_ENV !== "production"`) drives two surgical chokepoints: (1) a client wallet shim that injects `window.ethereum` with `isMiniPay: true` and signs auth locally with a throwaway key, so the real `/api/auth/verify` path passes unchanged; (2) the single on-chain payout function `payReward()`, which returns a fake tx hash instead of broadcasting. Hard-off in production.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, viem (isomorphic), Vitest (node environment), Prisma.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `lib/simulation.ts` | **new** — browser-safe gate + simulated identity + provider factory. No Node-only imports. |
| `lib/__tests__/simulation.test.ts` | **new** — tests for the gate and the provider factory. |
| `lib/payout.ts` | **modify** — sim short-circuit in `payReward()` and `waitForTx()`; local fake-hash helper. |
| `lib/__tests__/payout-sim.test.ts` | **new** — test `payReward()` sim behavior. |
| `components/MiniPaySimulator.tsx` | **new** — client component that installs the shim on `window`. |
| `app/layout.tsx` | **modify** — render `<MiniPaySimulator />`. |
| `app/page.tsx` | **modify** — hide the "View on explorer" link in sim mode. |
| `.env.local.example` | **modify** — document the two env vars. |

**Branch:** work continues on `feat/minipay-simulation-mode` (already created; spec committed there).

---

### Task 1: Simulation gate + identity (`lib/simulation.ts`)

**Files:**
- Create: `lib/simulation.ts`
- Test: `lib/__tests__/simulation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/simulation.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { isSimulationMode, simulatedAddress } from "@/lib/simulation";

afterEach(() => vi.unstubAllEnvs());

describe("isSimulationMode", () => {
  it("is true when flag is 1 and NODE_ENV is not production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SIMULATE_MINIPAY", "1");
    expect(isSimulationMode()).toBe(true);
  });

  it("is false when the flag is unset", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SIMULATE_MINIPAY", "");
    expect(isSimulationMode()).toBe(false);
  });

  it("is hard-off in production even with the flag set to 1", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SIMULATE_MINIPAY", "1");
    expect(isSimulationMode()).toBe(false);
  });
});

describe("simulatedAddress", () => {
  it("derives a lowercase 0x address from the default key", () => {
    const addr = simulatedAddress();
    expect(addr).toMatch(/^0x[0-9a-f]{40}$/);
    // Default key is Hardhat/Anvil account #0
    expect(addr).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run lib/__tests__/simulation.test.ts`
Expected: FAIL — `Cannot find module '@/lib/simulation'` (or "isSimulationMode is not a function").

- [ ] **Step 3: Write minimal implementation**

Create `lib/simulation.ts`:

```ts
import { privateKeyToAccount } from "viem/accounts";

/**
 * Local-dev-only MiniPay simulation gate. Hard-off in production regardless of
 * the flag, so it can never affect a real deploy.
 *
 * NOTE: This module is imported by BOTH the client shim and server code, so it
 * must contain no Node-only imports (no `node:crypto`). It depends only on
 * `viem/accounts` (isomorphic) and `process.env`.
 */
export function isSimulationMode(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.NEXT_PUBLIC_SIMULATE_MINIPAY === "1"
  );
}

// Well-known local dev key (Hardhat/Anvil account #0). Throwaway — no real funds.
// Public so the client shim can read it to sign in-browser.
const DEFAULT_SIM_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export const SIMULATED_WALLET_PRIVATE_KEY = (process.env
  .NEXT_PUBLIC_SIMULATED_WALLET_PRIVATE_KEY ?? DEFAULT_SIM_KEY) as `0x${string}`;

export function simulatedAddress(): `0x${string}` {
  return privateKeyToAccount(
    SIMULATED_WALLET_PRIVATE_KEY,
  ).address.toLowerCase() as `0x${string}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run lib/__tests__/simulation.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/simulation.ts lib/__tests__/simulation.test.ts
git commit -m "feat(sim): add MiniPay simulation gate and identity"
```

---

### Task 2: Simulated wallet provider factory (`lib/simulation.ts`)

**Files:**
- Modify: `lib/simulation.ts`
- Test: `lib/__tests__/simulation.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `lib/__tests__/simulation.test.ts`:

```ts
import { recoverMessageAddress } from "viem";
import { createSimulatedProvider } from "@/lib/simulation";

describe("createSimulatedProvider", () => {
  it("reports MiniPay and returns the simulated address for eth_requestAccounts", async () => {
    const provider = createSimulatedProvider();
    expect(provider.isMiniPay).toBe(true);
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    expect(accounts).toEqual([simulatedAddress()]);
  });

  it("personal_sign produces a signature that recovers to the simulated address", async () => {
    const provider = createSimulatedProvider();
    const message =
      "Centient Labeler Authentication\nWallet: 0xabc\nNonce: nonce123";
    const signature = (await provider.request({
      method: "personal_sign",
      params: [message, simulatedAddress()],
    })) as `0x${string}`;
    const recovered = (
      await recoverMessageAddress({ message, signature })
    ).toLowerCase();
    expect(recovered).toBe(simulatedAddress());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run lib/__tests__/simulation.test.ts`
Expected: FAIL — `createSimulatedProvider is not a function` (export missing).

- [ ] **Step 3: Write minimal implementation**

Append to `lib/simulation.ts`:

```ts
export interface SimulatedProvider {
  isMiniPay: true;
  __sim: true;
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/**
 * Build an injected-wallet shim backed by the local simulated key. Mirrors the
 * subset of the EIP-1193 provider the app actually uses:
 *  - eth_requestAccounts / eth_accounts -> [simulated address]
 *  - personal_sign -> a real local signature (so /api/auth/verify passes)
 *  - chain-switch calls -> no-op
 */
export function createSimulatedProvider(): SimulatedProvider {
  const account = privateKeyToAccount(SIMULATED_WALLET_PRIVATE_KEY);
  const address = account.address.toLowerCase();
  return {
    isMiniPay: true,
    __sim: true,
    async request({ method, params }) {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [address];
        case "personal_sign": {
          const message = (params?.[0] ?? "") as string;
          return account.signMessage({ message });
        }
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          return null;
        default:
          return null;
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run lib/__tests__/simulation.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add lib/simulation.ts lib/__tests__/simulation.test.ts
git commit -m "feat(sim): add simulated EIP-1193 wallet provider factory"
```

---

### Task 3: Payout short-circuit (`lib/payout.ts`)

**Files:**
- Modify: `lib/payout.ts` (imports at top; `payReward` at line 42; `waitForTx` at line 84)
- Test: `lib/__tests__/payout-sim.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/payout-sim.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { payReward, waitForTx } from "@/lib/payout";

afterEach(() => vi.unstubAllEnvs());

describe("payReward in simulation mode", () => {
  it("returns a well-formed fake tx hash without configuring a payout wallet", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SIMULATE_MINIPAY", "1");
    // Real path would throw "PAYOUT_PRIVATE_KEY is not configured"; sim returns first.
    vi.stubEnv("PAYOUT_PRIVATE_KEY", "");

    const hash = await payReward(
      "0x1234567890123456789012345678901234567890",
    );
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("waitForTx in simulation mode", () => {
  it("returns a success receipt without hitting the chain", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SIMULATE_MINIPAY", "1");

    const receipt = await waitForTx(
      "0x1234567890123456789012345678901234567890123456789012345678901234",
    );
    expect(receipt.status).toBe("success");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run lib/__tests__/payout-sim.test.ts`
Expected: FAIL — `payReward` throws `PAYOUT_PRIVATE_KEY is not configured` (sim guard not yet added).

- [ ] **Step 3: Write minimal implementation**

In `lib/payout.ts`, update the import line that currently reads:

```ts
import { createPublicClient, createWalletClient, http, parseUnits, erc20Abi } from "viem";
```

to add the `TransactionReceipt` type:

```ts
import { createPublicClient, createWalletClient, http, parseUnits, erc20Abi, type TransactionReceipt } from "viem";
```

Add these two imports below the existing import block (after the `payout-cap` import):

```ts
import { randomBytes } from "node:crypto";
import { isSimulationMode } from "./simulation";
```

Add this helper just above `export async function payReward`:

```ts
// Local-sim only: a syntactically valid 0x + 64-hex hash, never broadcast.
function simulatedTxHash(): `0x${string}` {
  return `0x${randomBytes(32).toString("hex")}`;
}
```

In `payReward`, insert the sim guard immediately after the `const amount = ...` line and before `await checkPayoutCap(amount);`:

```ts
export async function payReward(to: `0x${string}`, amountWei?: bigint): Promise<`0x${string}`> {
  const amount = amountWei ?? rewardInWei();

  if (isSimulationMode()) {
    return simulatedTxHash();
  }

  await checkPayoutCap(amount);
  // ... rest unchanged
```

Replace the body of `waitForTx` so it short-circuits in sim mode:

```ts
export async function waitForTx(hash: `0x${string}`) {
  if (isSimulationMode()) {
    return { status: "success", transactionHash: hash } as unknown as TransactionReceipt;
  }
  return publicClient().waitForTransactionReceipt({ hash, timeout: 30_000 });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run lib/__tests__/payout-sim.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full payout test file to confirm no regression**

Run: `pnpm exec vitest run lib/__tests__ app/api/submit`
Expected: PASS (existing submit/payout tests still green; sim mode is off by default in those — `NEXT_PUBLIC_SIMULATE_MINIPAY` unset).

- [ ] **Step 6: Commit**

```bash
git add lib/payout.ts lib/__tests__/payout-sim.test.ts
git commit -m "feat(sim): short-circuit payReward and waitForTx in simulation mode"
```

---

### Task 4: Client wallet shim component (`components/MiniPaySimulator.tsx`)

**Files:**
- Create: `components/MiniPaySimulator.tsx`
- Modify: `app/layout.tsx`

No unit test: the Vitest environment is `node` (no DOM), and this is thin wiring around the already-tested factory. Verified by typecheck + manual run in Task 6.

- [ ] **Step 1: Create the component**

Create `components/MiniPaySimulator.tsx`:

```tsx
"use client";

import { useState } from "react";
import { isSimulationMode, createSimulatedProvider } from "@/lib/simulation";

/**
 * Dev-only: installs a simulated MiniPay wallet on `window.ethereum` so the app
 * behaves as if opened inside MiniPay. Installed during the render phase (via a
 * useState initializer) so it exists before the home page's mount effect runs
 * `isMiniPay()`. Renders nothing. No-op unless `isSimulationMode()`.
 */
export default function MiniPaySimulator() {
  useState(() => {
    if (typeof window === "undefined") return null;
    if (!isSimulationMode()) return null;
    const w = window as unknown as { ethereum?: { __sim?: boolean } };
    if (w.ethereum?.__sim) return null;
    w.ethereum = createSimulatedProvider();
    return null;
  });

  return null;
}
```

- [ ] **Step 2: Wire it into the layout**

In `app/layout.tsx`, add the import after the existing component imports (e.g. after the `PostHogProvider` import):

```tsx
import MiniPaySimulator from "@/components/MiniPaySimulator";
```

In the same file, render it as the first child inside `<body>`, immediately before `<ErrorBoundary ...>`:

```tsx
      <body className="bg-surface text-on-surface antialiased">
        <MiniPaySimulator />
        <ErrorBoundary fallback={<ErrorFallback />}>
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
git add components/MiniPaySimulator.tsx app/layout.tsx
git commit -m "feat(sim): install simulated MiniPay wallet shim via layout"
```

---

### Task 5: Hide explorer link in sim mode (`app/page.tsx`)

**Files:**
- Modify: `app/page.tsx` (success-screen copy near lines 453-471)

No unit test: client UI under the `node` test environment; verified manually in Task 6.

- [ ] **Step 1: Add the import**

In `app/page.tsx`, add to the imports near the top (after the `@/lib/constants` import on line 18):

```tsx
import { isSimulationMode } from "@/lib/simulation";
```

- [ ] **Step 2: Update the success-screen condition**

In the success screen's `<p>`, change the opening condition of the ternary from:

```tsx
            {lastTxHash ? (
```

to:

```tsx
            {lastTxHash && !isSimulationMode() ? (
```

(Leave the rest of the ternary unchanged. In sim mode `lastTxHash` is the fake hash and `pendingSubmissionId` has been cleared, so the branch falls through to the plain "Your contribution helps improve AI." text with no explorer link.)

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx
git commit -m "feat(sim): hide explorer link on success screen in simulation mode"
```

---

### Task 6: Document env vars and verify end-to-end (`.env.local.example`)

**Files:**
- Modify: `.env.local.example`

- [ ] **Step 1: Document the env vars**

Append to `.env.local.example`:

```bash
# ── Local MiniPay simulation (dev only; hard-off when NODE_ENV=production) ──
# Set to 1 to simulate running inside MiniPay end-to-end (login + payout) with
# no MetaMask, no MiniPay account, and no Celo connection. Run `pnpm payout`
# alongside `pnpm dev` so the queued payout job is processed.
# NEXT_PUBLIC_SIMULATE_MINIPAY=1
# Optional: override the simulated labeler's local test key (throwaway, no funds).
# NEXT_PUBLIC_SIMULATED_WALLET_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`
Expected: PASS (all existing tests plus the new simulation/payout-sim tests).

- [ ] **Step 3: Manual end-to-end verification**

1. Add `NEXT_PUBLIC_SIMULATE_MINIPAY=1` to `.env.local`.
2. Terminal A: `pnpm dev`
3. Terminal B: `pnpm payout`
4. Open `http://localhost:3000` in a normal browser (no MetaMask).
   - Expected: it does NOT show the "Continue with MetaMask" landing; it auto-connects and goes to onboarding (first run) or landing.
5. Complete onboarding, open a task, pick a response, submit.
   - Expected: success screen shows "Paid 0.05 cUSD", balance updates within a few seconds, and there is NO "View on explorer" link.
6. Check Terminal B logs: a line like `[payout-worker] job <id> completed: submission <id> paid 0x…`.
7. Sanity check the off switch: remove/comment `NEXT_PUBLIC_SIMULATE_MINIPAY`, restart `pnpm dev`, reload — the MetaMask landing page returns.

- [ ] **Step 4: Commit**

```bash
git add .env.local.example
git commit -m "docs(sim): document MiniPay simulation env vars"
```

---

## Self-Review Notes

- **Spec coverage:** gate + identity (Task 1), provider factory/login (Task 2), payout short-circuit incl. `waitForTx` (Task 3), shim install (Task 4), explorer-link hide (Task 5), env docs + manual verify (Task 6). All spec sections covered.
- **Type consistency:** `isSimulationMode`, `simulatedAddress`, `createSimulatedProvider`, `SimulatedProvider`, `SIMULATED_WALLET_PRIVATE_KEY` are defined in Tasks 1–2 and consumed with the same names/signatures in Tasks 3–5. `payReward`/`waitForTx` signatures unchanged.
- **Browser-safety:** `lib/simulation.ts` imports only `viem/accounts`; `node:crypto` is confined to `lib/payout.ts` (server-only).
- **Default-off guarantee:** every behavior is gated by `isSimulationMode()`, which requires the flag AND non-production; existing tests run with the flag unset.

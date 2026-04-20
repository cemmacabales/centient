# spec.md — AI Training Data Platform MVP (Celo MiniPay)

> One-day MVP. Users label AI training data inside the Celo MiniPay wallet and are paid per task in cUSD. Scope is intentionally minimal. Do not add features that are not in this spec.

---

## 1. Product summary

A Next.js web app that runs **inside the MiniPay mobile wallet** as a Mini App. A user opens the app, sees an AI response-pair comparison task, picks which response is better, writes a one-line reason, and instantly receives a small cUSD payment to their MiniPay wallet.

**The single task type for v1:** response-pair preference ranking.
- Display: one prompt + response A + response B.
- User action: tap "A is better" or "B is better", type a reason (min 10 characters), submit.
- Reward: 0.05 cUSD per valid submission (configurable via env var).

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 14+ (App Router) |
| Language | TypeScript |
| DB | PostgreSQL 15+ (use `pg` or `postgres` driver; Prisma optional) |
| Styling | Tailwind CSS |
| Blockchain lib | `viem` (v2.x) |
| Chain | Celo mainnet (chainId 42220). Testing on Celo Sepolia (chainId 11142220). |
| Hosting | Vercel (frontend + API routes). Any managed Postgres (Neon, Supabase, Railway). |
| Node | 20+ |

Do NOT use: wagmi (unnecessary overhead for this MVP), RainbowKit, WalletConnect. MiniPay injects the provider directly.

---

## 3. Directory layout

```
/app
  /page.tsx                  # Landing / current task
  /api
    /task/route.ts           # GET next task for wallet
    /submit/route.ts         # POST submission, trigger payout
    /me/route.ts             # GET user stats (earnings, count)
/lib
  /db.ts                     # Postgres client
  /minipay.ts                # Wallet detection + client-side helpers
  /payout.ts                 # Server-side cUSD transfer via viem
  /quality.ts                # Gold-task validation logic
  /constants.ts              # Token addresses, chain config, reward amount
/db
  /schema.sql                # Create tables
  /seed.sql                  # ~100 task pairs + ~10 gold tasks
/components
  /TaskCard.tsx
  /SubmitButton.tsx
  /EarningsBadge.tsx
/types
  /index.ts
.env.local
```

---

## 4. PostgreSQL schema

Create file `/db/schema.sql`:

```sql
-- Users identified by their wallet address (lowercased, 0x-prefixed, 42 chars).
CREATE TABLE users (
  wallet_address   TEXT PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_earned_wei NUMERIC(78, 0) NOT NULL DEFAULT 0,
  submission_count INT NOT NULL DEFAULT 0,
  gold_correct     INT NOT NULL DEFAULT 0,
  gold_attempted   INT NOT NULL DEFAULT 0,
  is_banned        BOOLEAN NOT NULL DEFAULT FALSE
);

-- A task = a prompt + two candidate responses to compare.
CREATE TABLE tasks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt         TEXT NOT NULL,
  response_a     TEXT NOT NULL,
  response_b     TEXT NOT NULL,
  model_a        TEXT,            -- e.g. "gpt-4o"
  model_b        TEXT,            -- e.g. "claude-opus-4-7"
  is_gold        BOOLEAN NOT NULL DEFAULT FALSE,
  gold_answer    CHAR(1),         -- 'A' or 'B' for gold tasks only
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tasks_is_gold ON tasks(is_gold);

-- One row per user submission. Unique(wallet, task) so nobody labels the same task twice.
CREATE TABLE submissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address  TEXT NOT NULL REFERENCES users(wallet_address),
  task_id         UUID NOT NULL REFERENCES tasks(id),
  choice          CHAR(1) NOT NULL CHECK (choice IN ('A', 'B')),
  reason          TEXT NOT NULL,
  is_gold_check   BOOLEAN NOT NULL DEFAULT FALSE,
  gold_passed     BOOLEAN,         -- null if not a gold task
  payout_amount_wei NUMERIC(78, 0) NOT NULL,
  payout_tx_hash  TEXT,            -- null until tx confirmed
  payout_status   TEXT NOT NULL DEFAULT 'pending', -- pending | sent | confirmed | failed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (wallet_address, task_id)
);

CREATE INDEX idx_submissions_wallet ON submissions(wallet_address);
CREATE INDEX idx_submissions_status ON submissions(payout_status);
```

---

## 5. Constants

`/lib/constants.ts`:

```ts
export const CELO_MAINNET = {
  id: 42220,
  name: "Celo",
  rpcUrl: "https://forno.celo.org",
  explorer: "https://celoscan.io",
};

export const CELO_SEPOLIA = {
  id: 11142220,
  name: "Celo Sepolia",
  rpcUrl: "https://forno.celo-sepolia.celo-testnet.org",
  explorer: "https://celo-sepolia.blockscout.com",
};

// cUSD on Celo Mainnet (Mento stable). Decimals = 18.
export const CUSD_MAINNET = "0x765DE816845861e75A25fCA122bb6898B8B1282a" as const;

// USDC on Celo Mainnet (Circle native). Decimals = 6. Kept for reference; v1 pays in cUSD.
export const USDC_MAINNET = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as const;

export const REWARD_CUSD = "0.05"; // string, converted to 18-decimal wei server-side
```

Verify these addresses against `https://docs.celo.org/tooling/contracts/token-contracts` at build time; do not hardcode testnet addresses here — read them from env for any non-mainnet deploy.

---

## 6. MiniPay integration rules (non-negotiable)

These come from Celo's official MiniPay docs. The coding agent MUST follow all of them:

1. **Detect MiniPay** via `window.ethereum.isMiniPay === true`. If present, the wallet is auto-connected — do NOT render a "Connect Wallet" button.
2. **Outside MiniPay**, show a full-screen message: *"Open this app inside the MiniPay wallet to continue. [link to https://minipay.to]"*. Do not attempt to use WalletConnect or other connectors.
3. **Legacy transactions only.** MiniPay does NOT support EIP-1559. When sending txs from the client, omit `maxFeePerGas` / `maxPriorityFeePerGas`. Use `gasPrice` only. (This only matters if the client ever signs a tx — in v1 the client does not, the server sends payouts. Still: do not call `eth_signTypedData` or request message signatures; MiniPay does not support message signing.)
4. Read the user's address via `provider.request({ method: "eth_requestAccounts" })`. This will return immediately in MiniPay.
5. Lowercase the returned address before storing it.

`/lib/minipay.ts` (client-only):

```ts
"use client";

export function isMiniPay(): boolean {
  if (typeof window === "undefined") return false;
  const eth = (window as any).ethereum;
  return !!eth && eth.isMiniPay === true;
}

export async function getWalletAddress(): Promise<string | null> {
  const eth = (window as any).ethereum;
  if (!eth) return null;
  const accounts: string[] = await eth.request({ method: "eth_requestAccounts" });
  return accounts[0]?.toLowerCase() ?? null;
}
```

---

## 7. Server-side payout

Payouts run on the server using a single hot wallet. Fund this wallet with cUSD on Celo mainnet before deploy. v1 does NOT use a queue — the payout call is awaited inline in the submit handler. This is fine for a one-day MVP at low volume.

`/lib/payout.ts`:

```ts
import { createPublicClient, createWalletClient, http, parseUnits, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { CUSD_MAINNET, REWARD_CUSD } from "./constants";

const account = privateKeyToAccount(process.env.PAYOUT_PRIVATE_KEY as `0x${string}`);

const publicClient = createPublicClient({
  chain: celo,
  transport: http(process.env.CELO_RPC_URL ?? "https://forno.celo.org"),
});

const walletClient = createWalletClient({
  account,
  chain: celo,
  transport: http(process.env.CELO_RPC_URL ?? "https://forno.celo.org"),
});

export async function payCUSD(to: `0x${string}`): Promise<`0x${string}`> {
  const amount = parseUnits(REWARD_CUSD, 18); // cUSD is 18 decimals
  const hash = await walletClient.writeContract({
    address: CUSD_MAINNET,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, amount],
    // Legacy tx — viem auto-selects based on chain, but we set gasPrice for safety.
    gas: 100_000n,
  });
  return hash;
}

export async function waitForTx(hash: `0x${string}`) {
  return publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
}
```

The server hot wallet needs a small amount of CELO for gas (~0.5 CELO is plenty for thousands of txs). Alternatively, use Celo's fee abstraction and pay gas in cUSD by passing `feeCurrency: CUSD_MAINNET` — MiniPay supports this, and viem supports `feeCurrency` on the `celo` chain config. Prefer native CELO for server payouts since it's simpler.

---

## 8. API endpoints

### `GET /api/task?wallet=0x...`

Returns the next task the user hasn't done. 10% of the time, return a gold task (random pick from `tasks WHERE is_gold = true`). Otherwise, return a random non-gold task not yet in `submissions` for this wallet.

Response:
```json
{
  "task": {
    "id": "uuid",
    "prompt": "string",
    "responseA": "string",
    "responseB": "string"
  }
}
```

Do NOT include `is_gold` or `gold_answer` in the response. Ever.

If the user has done every task, return `{ "task": null, "message": "No more tasks available" }`.

### `POST /api/submit`

Body:
```json
{
  "walletAddress": "0x...",
  "taskId": "uuid",
  "choice": "A" | "B",
  "reason": "string"
}
```

Server logic (in this order):

1. Validate input: `walletAddress` is a valid 0x40 hex, `choice` is A or B, `reason.trim().length >= 10`, `taskId` exists.
2. Upsert the user row (insert if not exists).
3. Check the user is not `is_banned`. If banned, return 403.
4. Check no existing submission for `(walletAddress, taskId)`. If exists, return 409.
5. Load the task. If `is_gold`:
   - Compare `choice` to `gold_answer`.
   - If wrong: record submission with `payout_amount_wei = 0`, `gold_passed = false`, `payout_status = 'skipped'`. Increment `users.gold_attempted`. If user's gold accuracy over their last 10 gold attempts drops below 50%, set `is_banned = true`. Return `{ paid: false, reason: "quality_check_failed" }`.
   - If correct: proceed to payout. Increment `gold_correct` and `gold_attempted`.
6. Insert the submission row with `payout_status = 'pending'`, `payout_amount_wei = parseUnits("0.05", 18)`.
7. Call `payCUSD(walletAddress)` → get `txHash`. Update row to `payout_status = 'sent'`, store `payout_tx_hash`.
8. Update `users.total_earned_wei += reward`, `users.submission_count += 1`.
9. Return `{ paid: true, txHash, explorerUrl: "https://celoscan.io/tx/..." }`.

Wrap steps 6–8 in a DB transaction. If the `payCUSD` call throws, update `payout_status = 'failed'` and return 500 with a retry message. Do NOT refund any DB state — keep the failed record for later manual retry.

### `GET /api/me?wallet=0x...`

```json
{
  "walletAddress": "0x...",
  "totalEarnedCUSD": "1.25",
  "submissionCount": 25
}
```

---

## 9. Frontend flow

`/app/page.tsx`:

1. On mount, check `isMiniPay()`. If false → render `OpenInMiniPay` screen.
2. If true → `await getWalletAddress()`, call `POST /api/me` (upsert) then `GET /api/task`.
3. Render `<TaskCard>` with prompt, responseA, responseB. Two big buttons: "A is better" and "B is better". On tap, highlight the choice and show a `<textarea>` for the reason (placeholder: *"One sentence on why — at least 10 characters."*).
4. `<SubmitButton>` is disabled until a choice is made and reason length ≥ 10. On click:
   - Show spinner.
   - `POST /api/submit`.
   - On success with `paid: true`: show toast "Paid 0.05 cUSD ✓" with explorer link, then auto-fetch next task after 1.5s.
   - On success with `paid: false`: show "Quality check failed — try another task." Fetch next task.
   - On error: show "Something went wrong" with a retry button.
5. Top-right `<EarningsBadge>` shows total earned, refreshed after each submission.

**Design:**
- Mobile-first, single column, large tap targets (min 48px).
- No navigation, no footer, no settings.
- Response A and B cards visually distinct (e.g. left-blue, right-green accents). Show them stacked, not side-by-side (mobile screens are narrow).

---

## 10. Environment variables

`.env.local` template:

```
DATABASE_URL=postgres://user:pass@host:5432/dbname
CELO_RPC_URL=https://forno.celo.org
PAYOUT_PRIVATE_KEY=0x...        # hot wallet funded with cUSD + small CELO for gas
REWARD_CUSD=0.05                # override REWARD_CUSD in constants if set
NEXT_PUBLIC_CHAIN_ID=42220
NEXT_PUBLIC_EXPLORER_URL=https://celoscan.io
```

The private key must NEVER be exposed to the client. Only use it in `/lib/payout.ts` which is server-only.

---

## 11. Seed data

`/db/seed.sql` should insert:
- ~90 non-gold response pairs covering: general Q&A, coding help, summarization, math, creative writing.
- ~10 gold-standard tasks where one response is obviously better (e.g. one is factually wrong, one is empty, one refuses inappropriately). Mark `is_gold = true` and set `gold_answer`.

Generate the pair content by running the same prompt through two different models offline and committing the output. For the MVP just hand-write or use one model at temp=0 vs temp=1.2 for variation. This is a one-time seed — do not build a generation pipeline.

---

## 12. Local dev & MiniPay testing

1. `createdb` → run `schema.sql` → run `seed.sql`.
2. `npm run dev` → Next.js on `localhost:3000`.
3. Install **ngrok** and run `ngrok http 3000` to get a public HTTPS URL.
4. On an Android phone with MiniPay installed:
   - Settings → About → tap Version number 10x to unlock Developer Settings.
   - Developer Settings → enable Developer Mode → toggle "Use Testnet" for Celo Sepolia testing.
   - Developer Settings → Load Test Page → paste ngrok URL → Go.
5. The app should load inside MiniPay with the wallet already available.

For the first end-to-end test on **mainnet**, set `REWARD_CUSD=0.01` to keep test payouts cheap.

---

## 13. Quality & abuse guards (v1 only)

- Gold-task rule: ban user if gold accuracy drops below 50% over their last 10 gold attempts (see §8 step 5).
- Rate limit: one submission per wallet per 15 seconds (enforce via an in-memory `Map<wallet, lastSubmitTs>` on the server — fine for single-instance MVP).
- Reason length ≥ 10 chars and not just repeated characters (reject `/^(.)\1+$/`).
- Reject submissions where `choice === "A"` more than 95% of the time across the user's last 20 submissions (left-bias bot check).

Everything else (Sybil resistance, KYC, rich reviewer pipelines, multi-task types) is **out of scope for v1**.

---

## 14. Explicit non-goals

Do not build: withdrawals (payouts are instant per-task), user profiles, login, email, password reset, admin dashboard, task creation UI, task types other than pair-ranking, multi-chain support, Base support (deferred to v2), i18n, dark mode toggle, analytics. The whole app should be < 1500 lines of code.

---

## 15. Acceptance criteria

The MVP is done when:

1. Opening the deployed URL inside MiniPay on a real Android phone loads a task within 2 seconds.
2. Submitting a valid choice results in a real cUSD transfer to the user's MiniPay wallet within 15 seconds, visible on Celoscan.
3. Submitting an incorrect answer to a gold task does NOT trigger a payout.
4. The same user cannot submit the same task twice (enforced by unique constraint).
5. The server hot wallet's balance decreases by the exact reward amount per successful submission.
6. `/api/me` returns correct cumulative earnings.

Ship it.

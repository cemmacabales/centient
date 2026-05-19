# spec.md — Centient MVP (Celo MiniPay)

> **Centient** — train AI, cent by cent. A MiniPay Mini App where users label AI training data and get paid micro-amounts in cUSD per task.
>
> **Production domain:** `https://centient.work`

> One-day MVP. Users label AI training data inside the Celo MiniPay wallet and are paid per task in cUSD. Scope is intentionally minimal. Do not add features that are not in this spec.

---

## 1. Product summary

**Centient** is a Next.js 16 web app that runs **inside the MiniPay mobile wallet** as a Mini App. A user opens Centient, sees an AI response-pair comparison task, picks which response is better, writes a one-line reason, and instantly receives a small cUSD payment to their MiniPay wallet.

The name is a portmanteau of **cent** (the micropayment) and **sentient** (the AI being trained). Tagline: *train AI, cent by cent.*

**The single task type for v1:** response-pair preference ranking.
- Display: one prompt + response A + response B.
- User action: tap "A is better" or "B is better", type a reason (min 10 characters), submit.
- Reward: 0.05 cUSD per valid submission (configurable via env var).

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Framework | **Next.js 16** (App Router, Turbopack by default, React 19.2) |
| Language | TypeScript 5.4+ |
| ORM | **Prisma 7** (`prisma-client` generator + `@prisma/adapter-pg`) |
| DB (local dev) | **Local PostgreSQL 15+** (Homebrew / apt / Docker) |
| DB (prod) | **Railway PostgreSQL** (provisioned in Railway project) |
| Styling | Tailwind CSS |
| Blockchain lib | `viem` v2.x |
| Chain | Celo mainnet (chainId 42220). Testing on Celo Sepolia (11142220). |
| Hosting | **Railway** (Next.js service + Postgres service in the same project) |
| Node | 20.19+ |

Do NOT use: Supabase, wagmi, RainbowKit, WalletConnect, Prisma Postgres managed. MiniPay injects the provider directly.

**Next.js 16 rules the coding agent MUST follow:**
- `params` and `searchParams` are async. Always `await props.params` / `await props.searchParams`.
- Turbopack is default — do NOT pass `--turbopack` flag, do NOT ship a `webpack` config.
- Middleware is `middleware.ts` at the project root.
- `next.config.ts` must set `output: "standalone"` for Railway.

**Prisma 7 rules (many things changed from Prisma 6):**
- Use `generator client { provider = "prisma-client" }` — NOT the old `"prisma-client-js"`.
- Do NOT put `url` inside the `datasource` block in `schema.prisma`. It lives in `prisma.config.ts`.
- Use `@prisma/adapter-pg` driver adapter for TCP connections.
- Import client from the generated path: `app/generated/prisma/client`.
- Requires Node 20.19+ and TypeScript 5.4+.

---

## 3. Directory layout

```
/app
  /layout.tsx
  /page.tsx                  # Landing / current task
  /api
    /task/route.ts           # GET next task for wallet
    /submit/route.ts         # POST submission, trigger payout
    /me/route.ts             # GET user stats
  /generated/prisma          # Prisma client output (git-ignored)
/lib
  /prisma.ts                 # Global Prisma client w/ adapter-pg
  /minipay.ts                # Client-side wallet detection
  /payout.ts                 # Server-side cUSD transfer (viem)
  /quality.ts                # Gold-task validation
  /constants.ts              # Token addresses, chain config
/prisma
  /schema.prisma
  /seed.ts                   # 100 task pairs (see §11 and companion file)
  /migrations/               # auto-generated
prisma.config.ts             # Prisma 7 config (datasource URL lives here)
/components
  /TaskCard.tsx
  /SubmitButton.tsx
  /EarningsBadge.tsx
/types/index.ts
next.config.ts
.env
.env.local
package.json
tsconfig.json
.gitignore                   # includes: app/generated, .env.local, node_modules
```

---

## 4. Package setup

`package.json`:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "prisma generate && next build",
    "start": "next start",
    "db:migrate": "prisma migrate dev",
    "db:deploy": "prisma migrate deploy",
    "db:seed": "prisma db seed",
    "db:studio": "prisma studio",
    "db:reset": "prisma migrate reset"
  },
  "dependencies": {
    "next": "^16.2.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "@prisma/client": "^7.0.0",
    "@prisma/adapter-pg": "^7.0.0",
    "viem": "^2.21.0"
  },
  "devDependencies": {
    "prisma": "^7.0.0",
    "typescript": "^5.4.0",
    "@types/node": "^20.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "tailwindcss": "^4.0.0",
    "tsx": "^4.7.0",
    "dotenv": "^16.4.0"
  }
}
```

Initial setup:

```bash
npm install
npx prisma init --output ../app/generated/prisma
```

---

## 5. Prisma schema

`prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../app/generated/prisma"
}

datasource db {
  provider = "postgresql"
  // NOTE: url lives in prisma.config.ts, NOT here.
}

model User {
  walletAddress   String   @id
  createdAt       DateTime @default(now())
  totalEarnedWei  BigInt   @default(0)
  submissionCount Int      @default(0)
  goldCorrect     Int      @default(0)
  goldAttempted   Int      @default(0)
  isBanned        Boolean  @default(false)

  submissions Submission[]

  @@map("users")
}

model Task {
  id         String   @id @default(uuid())
  prompt     String
  responseA  String
  responseB  String
  modelA     String?
  modelB     String?
  category   String?
  isGold     Boolean  @default(false)
  goldAnswer String?  // "A" or "B" for gold tasks
  createdAt  DateTime @default(now())

  submissions Submission[]

  @@index([isGold])
  @@map("tasks")
}

model Submission {
  id              String   @id @default(uuid())
  walletAddress   String
  taskId          String
  choice          String   // "A" or "B"
  reason          String
  isGoldCheck     Boolean  @default(false)
  goldPassed      Boolean?
  payoutAmountWei BigInt
  payoutTxHash    String?
  payoutStatus    String   @default("pending") // pending | sent | confirmed | failed | skipped
  createdAt       DateTime @default(now())

  user User @relation(fields: [walletAddress], references: [walletAddress])
  task Task @relation(fields: [taskId], references: [id])

  @@unique([walletAddress, taskId])
  @@index([walletAddress])
  @@index([payoutStatus])
  @@map("submissions")
}
```

`prisma.config.ts` (project root):

```ts
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
```

`lib/prisma.ts` (singleton — critical for avoiding dev hot-reload connection blowup):

```ts
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = global as unknown as { prisma: PrismaClient };

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

export const prisma =
  globalForPrisma.prisma || new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export default prisma;
```

---

## 6. Constants

`lib/constants.ts`:

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

// cUSD on Celo Mainnet — 18 decimals.
export const CUSD_MAINNET = "0x765DE816845861e75A25fCA122bb6898B8B1282a" as const;

// USDC on Celo Mainnet — 6 decimals. Reference only; v1 pays in cUSD.
export const USDC_MAINNET = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as const;

export const REWARD_CUSD = process.env.REWARD_CUSD ?? "0.05";
```

---

## 7. MiniPay integration rules

Non-negotiable, straight from Celo's docs:

1. Detect via `window.ethereum.isMiniPay === true`. If true, wallet is auto-connected — do NOT render a Connect Wallet button.
2. Outside MiniPay: show a full-screen message *"Open this app inside the MiniPay wallet to continue."* with link to `https://minipay.to`.
3. Legacy transactions only on client (irrelevant in v1 since all signing is server-side).
4. No message signing. Do not call `eth_signTypedData`.
5. Read address via `eth_requestAccounts`. Lowercase before storing.

`lib/minipay.ts`:

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

## 8. Server-side payout

Single hot wallet, funded with cUSD + ~0.5 CELO for gas. Inline payouts (no queue) — fine for MVP volume.

`lib/payout.ts`:

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
  return walletClient.writeContract({
    address: CUSD_MAINNET,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, parseUnits(REWARD_CUSD, 18)],
    gas: 100_000n,
  });
}

export async function waitForTx(hash: `0x${string}`) {
  return publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
}

export function rewardInWei(): bigint {
  return parseUnits(REWARD_CUSD, 18);
}
```

---

## 9. API endpoints

### `GET /api/task?wallet=0x...`

Next task the user hasn't done. 10% gold, 90% regular.

```ts
// app/api/task/route.ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.toLowerCase();
  if (!wallet || !/^0x[a-f0-9]{40}$/.test(wallet)) {
    return NextResponse.json({ error: "invalid_wallet" }, { status: 400 });
  }

  const useGold = Math.random() < 0.1;

  const done = await prisma.submission.findMany({
    where: { walletAddress: wallet },
    select: { taskId: true },
  });
  const doneIds = done.map((s) => s.taskId);

  const task = await prisma.task.findFirst({
    where: { isGold: useGold, id: { notIn: doneIds } },
    orderBy: { createdAt: "asc" },
  });

  if (!task) {
    return NextResponse.json({ task: null, message: "No more tasks available" });
  }

  return NextResponse.json({
    task: {
      id: task.id,
      prompt: task.prompt,
      responseA: task.responseA,
      responseB: task.responseB,
    },
  });
}
```

Never include `isGold` or `goldAnswer` in the response.

### `POST /api/submit`

Body: `{ walletAddress, taskId, choice: "A"|"B", reason }`.

Server order:

1. Validate: `walletAddress` matches `/^0x[a-f0-9]{40}$/`, `choice` ∈ {A,B}, `reason.trim().length >= 10`.
2. Upsert user.
3. If `user.isBanned` → 403.
4. If existing submission for `(walletAddress, taskId)` → 409.
5. Load task. If `task.isGold`:
   - Wrong answer: record with `payoutAmountWei = 0`, `goldPassed = false`, `payoutStatus = "skipped"`. Increment `goldAttempted`. If last-10 gold accuracy < 50%, set `isBanned = true`. Return `{ paid: false, reason: "quality_check_failed" }`.
   - Correct: increment `goldCorrect` and `goldAttempted`, proceed.
6. Inside `prisma.$transaction`: create submission (`payoutStatus = "pending"`, `payoutAmountWei = rewardInWei()`).
7. Call `payCUSD(walletAddress)`. Update submission `payoutStatus = "sent"`, `payoutTxHash`. Update user counters.
8. Return `{ paid: true, txHash, explorerUrl }`.

On `payCUSD` throw: update `payoutStatus = "failed"`, return 500. Do not refund user counters.

### `GET /api/me?wallet=0x...`

```json
{
  "walletAddress": "0x...",
  "totalEarnedCUSD": "1.25",
  "submissionCount": 25
}
```

Format via `formatUnits(user.totalEarnedWei, 18)`.

---

## 10. Frontend

`app/page.tsx`:

1. On mount: `isMiniPay()`? If no → `OpenInMiniPay` screen.
2. Yes → `getWalletAddress()` → fetch `/api/me`, then `/api/task`.
3. `<TaskCard>` shows prompt + responseA + responseB. Two big buttons: "A is better" / "B is better".
4. After choice: reveal reason textarea (≥10 chars enables Submit).
5. Submit → spinner → toast with explorer link → auto-next after 1.5s.
6. `<EarningsBadge>` refreshes after each submission.

Design: mobile-first, single column, tap targets ≥ 48px. Response A blue accent, B green accent, stacked vertically. No nav, no footer.

**Brand:** show "Centient" as the header/logo text at the top of every screen. HTML `<title>` = `"Centient"`. Favicon and any og:image use the Centient name. On the `OpenInMiniPay` screen, headline is *"Centient runs inside MiniPay"* with subtitle *"Train AI, cent by cent."* and a link button to `https://minipay.to`.

---

## 11. Seed script (agent task)

**Create `prisma/seed.ts`** that loads **exactly 100 task pairs** into the `Task` table — **90 regular + 10 gold**.

### Requirements

1. **Stable IDs + upsert.** Give every task a deterministic string ID (e.g. `"gen-001"`, `"code-015"`, `"gold-003"`) and use `prisma.task.upsert` keyed on that ID. Re-running `npm run db:seed` must not duplicate rows.

2. **Use the generated client + adapter-pg**, matching the runtime setup in `lib/prisma.ts`:
   ```ts
   import "dotenv/config";
   import { PrismaClient } from "../app/generated/prisma/client";
   import { PrismaPg } from "@prisma/adapter-pg";

   const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
   const prisma = new PrismaClient({ adapter });
   ```
   End the script with `await prisma.$disconnect()` in a `finally` block, and `process.exit(1)` on error.

3. **Registered in `prisma.config.ts`** under `migrations.seed: "tsx prisma/seed.ts"` (already specified in §5). Runnable via `npm run db:seed`.

4. **Category coverage for the 90 regular pairs:**
   - General knowledge Q&A — 15
   - Coding help — 15
   - Writing / editing — 10
   - Math & reasoning — 15
   - Explanations (how things work) — 15
   - Creative (names, slogans, short fiction) — 10
   - Advice / recommendations — 10

   Set `category` on each task (`"general"`, `"coding"`, `"writing"`, `"math"`, `"explanation"`, `"creative"`, `"advice"`).

5. **Content rules for regular pairs:**
   - Same prompt, two different responses.
   - One response should generally be better than the other — but not trivially so. Vary *why* one is better: sometimes more accurate, sometimes more concise, sometimes better structured, sometimes more helpful tone.
   - **Roughly balance which side wins.** Do NOT always put the better response in A. Target ~50/50 across the 90 pairs. This prevents training annotators to blindly pick one side.
   - Do NOT vary response length systematically (don't make "better" always mean "longer"). Include cases where the shorter response is the better one.
   - `isGold` = false, `goldAnswer` = null for all regular pairs.

6. **Content rules for the 10 gold pairs:**
   - One response is **obviously** wrong or broken, the other is clearly correct.
   - Cover these failure modes across the 10:
     - Factually wrong answer (e.g. wrong capital, wrong arithmetic) — 4 pairs
     - Empty or near-empty response — 2 pairs
     - Inappropriate refusal to a benign question — 2 pairs
     - Nonsense / off-topic response — 2 pairs
   - `isGold` = true, `goldAnswer` = `"A"` or `"B"` indicating the correct choice.
   - Balance which side is correct across the 10 (roughly 5 A and 5 B).
   - Prompts should be simple and unambiguous so a reasonable person cannot disagree with the gold answer.

7. **Logging.** On completion print `Seeded N tasks (M gold)` so the operator sees confirmation.

### Acceptance

After running `npm run db:seed` twice in a row against a fresh DB:
- `SELECT COUNT(*) FROM tasks` returns exactly 100.
- `SELECT COUNT(*) FROM tasks WHERE is_gold = true` returns exactly 10.
- No duplicate rows, no errors on the second run.
- Category counts match the distribution in rule 4.

---

## 12. Environment variables

`.env.local` for development (git-ignored):

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/centient_dev
CELO_RPC_URL=https://forno.celo.org
PAYOUT_PRIVATE_KEY=0x...             # funded hot wallet
REWARD_CUSD=0.05
NEXT_PUBLIC_CHAIN_ID=42220
NEXT_PUBLIC_EXPLORER_URL=https://celoscan.io
```

Never expose `PAYOUT_PRIVATE_KEY` to the client. It's used only in `lib/payout.ts`.

On Railway, `DATABASE_URL` comes from the linked Postgres service — do not hardcode.

---

## 13. Local PostgreSQL setup (testing)

Pick ONE option:

**A. macOS (Homebrew):**
```bash
brew install postgresql@15
brew services start postgresql@15
createdb centient_dev
```

**B. Ubuntu/Debian:**
```bash
sudo apt install postgresql-15
sudo -u postgres createdb centient_dev
sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD 'postgres';"
```

**C. Docker (recommended for consistency across machines):**
```bash
docker run --name centient-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=centient_dev \
  -p 5432:5432 \
  -d postgres:15
```

Initialize:

```bash
npm install
npx prisma migrate dev --name init   # creates tables
npm run db:seed                       # loads 100 tasks
npm run dev                           # starts localhost:3000
```

Inspect DB: `npm run db:studio` → opens Prisma Studio on localhost:5555.

---

## 14. Railway deployment (production)

Railway hosts Next.js + Postgres in one project. Steps:

1. **Push repo to GitHub.**
2. **New Railway project** → Deploy from GitHub Repo → select repo. Railway auto-detects Next.js via Railpack, runs `npm run build` → `npm start`.
3. **Add Postgres** → `+ New` → Database → PostgreSQL. Railway provisions it and exposes `DATABASE_URL` on the Postgres service.
4. **Link DATABASE_URL** → Next.js service → Variables → Add Reference Variable → pick `DATABASE_URL` from the Postgres service. Keeps it in sync on credential rotation.
5. **Add remaining vars** on the Next.js service: `PAYOUT_PRIVATE_KEY`, `CELO_RPC_URL`, `REWARD_CUSD`, `NEXT_PUBLIC_CHAIN_ID`, `NEXT_PUBLIC_EXPLORER_URL`.
6. **Pre-deploy command** → Next.js service → Settings → Deploy → Pre-Deploy Command:
   ```
   npx prisma migrate deploy
   ```
   Runs migrations before new traffic. Never run `prisma migrate dev` in prod.
7. **Seed once** via Railway CLI:
   ```bash
   railway login
   railway link
   railway run npm run db:seed
   ```
   Idempotent thanks to `upsert` in seed script.
8. **`next.config.ts`:**
   ```ts
   import type { NextConfig } from "next";
   const config: NextConfig = { output: "standalone" };
   export default config;
   ```
9. **Public URL & custom domain** → Next.js service → Settings → Networking.
   - For initial testing: click `Generate Domain` to get a `*.up.railway.app` URL. Use this in MiniPay's Load Test Page.
   - For production: click `Custom Domain`, enter `centient.work` (and optionally `www.centient.work`). Railway will display a CNAME target — add it at your domain registrar's DNS settings. Railway auto-provisions an SSL cert once DNS propagates (typically minutes, can take up to an hour).
   - If the registrar doesn't allow a CNAME on the apex (`centient.work` with no subdomain), use ALIAS / ANAME if offered, or set the Railway-provided A records. Most modern registrars (Cloudflare, Namecheap, Porkbun) handle apex CNAMEs via flattening.
   - Once SSL is live, confirm `https://centient.work` loads the app, then paste that URL into MiniPay's Load Test Page for the production test.

---

## 15. MiniPay testing

1. Install MiniPay on Android.
2. Unlock dev mode: Settings → About → tap Version 10x → Developer Settings → enable → toggle **Use Testnet** for Celo Sepolia.
3. Fund the server hot wallet with cUSD + ~0.5 CELO (faucet on testnet, real tokens on mainnet).
4. Local test: `npm run dev` + `ngrok http 3000`, paste ngrok URL into MiniPay → Developer Settings → Load Test Page.
5. Prod test: paste `https://centient.work` into Load Test Page.
6. First mainnet test: set `REWARD_CUSD=0.01`.

Android Studio emulator does not work. Real device only.

---

## 16. Quality & abuse guards (v1)

- Gold-task ban: banned if gold accuracy < 50% over last 10 attempts.
- Rate limit: 1 submission per wallet per 15s (in-memory `Map`).
- Reason: ≥10 chars, reject `/^(.)\1+$/`.
- Left-bias: reject if user's last 20 submissions are >95% the same choice.

Out of scope: Sybil resistance, KYC, multi-reviewer consensus, expertise routing, additional task types.

---

## 17. Non-goals

No withdrawals, profiles, login, email, admin dashboard, task creation UI, non-pair tasks, multi-chain, Base, i18n, dark mode, analytics. Full app < 1500 LOC.

---

## 18. Acceptance criteria

1. `https://centient.work` loads a task inside MiniPay (Android) in < 2s.
2. Valid submission → real cUSD transfer on Celoscan within 15s.
3. Wrong gold-task answer → no payout.
4. Same user cannot submit same task twice.
5. Server wallet decreases by exact reward per successful submission.
6. `/api/me` returns correct cumulative earnings.
7. `npm run db:seed` creates exactly 100 tasks (90 regular + 10 gold), idempotent on re-run.

Ship it.

# Campaign Balance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a prepaid campaign balance system with per-submission debit, a SUPER_ADMIN deposit API, and a balance card on the campaign detail page.

**Architecture:** A new `lib/campaign-balance.ts` module encapsulates all balance logic (check+debit, credit, summary). The submit route calls `checkAndDebit()` between submission creation and payout. Two new admin API routes handle deposits and balance reads. A `BalanceCard` client component is added to `CampaignDetail`.

**Tech Stack:** Next.js 14 App Router, Prisma (PostgreSQL), Vitest (integration tests hitting real DB), viem (BigInt wei math), React/Tailwind for UI.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `prisma/schema.prisma` | Add `CampaignBalance`, `BalanceLedger`, `LedgerType` enum, `Campaign.balance` relation |
| Modify | `tests/helpers/db.ts` | Add new tables to `truncateAll()` |
| Modify | `tests/helpers/factories.ts` | Add `createCampaignBalance()` factory |
| Create | `lib/campaign-balance.ts` | `checkAndDebit`, `creditBalance`, `getBalanceSummary`, `InsufficientBalanceError`, `getPlatformFeeWei` |
| Create | `lib/__tests__/campaign-balance.test.ts` | Integration tests for all lib exports |
| Create | `app/api/admin/campaigns/[id]/deposit/route.ts` | `POST` — SUPER_ADMIN credits balance |
| Create | `app/api/admin/campaigns/[id]/balance/route.ts` | `GET` — returns balance + recent ledger |
| Modify | `app/api/submit/route.ts` | Call `checkAndDebit()` after submission create, before `payReward` |
| Modify | `app/api/submit/__tests__/route.test.ts` | Add balance-related submit tests |
| Create | `components/admin/BalanceCard.tsx` | Client component: balance display + deposit form for SUPER_ADMIN |
| Modify | `components/admin/CampaignDetail.tsx` | Accept + render `BalanceCard` |
| Modify | `app/admin/(protected)/campaigns/[id]/page.tsx` | Fetch initial balance, pass to `CampaignDetail` |
| Modify | `.env.local.example` | Document `PLATFORM_FEE_WEI` |
| Modify | `vitest.config.ts` | Add coverage thresholds for new lib and API files |

---

## Task 1: Create Feature Branch

**Files:** none

- [ ] **Step 1: Create and switch to branch**

```bash
git checkout -b feat/204-campaign-balance
```

Expected: `Switched to a new branch 'feat/204-campaign-balance'`

---

## Task 2: Schema Changes + Migration

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add new enum and models to schema**

Open `prisma/schema.prisma`. Add the following after the existing `UploadJob` model at the bottom:

```prisma
enum LedgerType {
  DEPOSIT
  DEBIT_REWARD
  DEBIT_FEE
  REFUND
}

model CampaignBalance {
  id         String   @id @default(cuid())
  campaignId String   @unique
  campaign   Campaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  balanceWei BigInt   @default(0)
  updatedAt  DateTime @updatedAt

  @@map("campaign_balances")
}

model BalanceLedger {
  id           String     @id @default(cuid())
  campaignId   String
  type         LedgerType
  amountWei    BigInt
  submissionId String?
  note         String?
  createdAt    DateTime   @default(now())

  @@index([campaignId, createdAt])
  @@map("balance_ledger")
}
```

Also add the `balance` relation to the existing `Campaign` model (inside the `Campaign` model block, after `uploadJobs UploadJob[]`):

```prisma
  balance    CampaignBalance?
```

- [ ] **Step 2: Run migration**

```bash
npx prisma migrate dev --name add-campaign-balance
```

Expected: `The following migration(s) have been created and applied from new schema changes: migrations/YYYYMMDDHHMMSS_add_campaign_balance/migration.sql`

If it asks to reset the DB, type `y` only in a dev environment.

- [ ] **Step 3: Regenerate Prisma client**

```bash
npx prisma generate
```

Expected: `Generated Prisma Client`

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add CampaignBalance and BalanceLedger schema (#204)"
```

---

## Task 3: Update Test Helpers

**Files:**
- Modify: `tests/helpers/db.ts`
- Modify: `tests/helpers/factories.ts`

- [ ] **Step 1: Add new tables to `truncateAll`**

In `tests/helpers/db.ts`, add two lines to `truncateAll()` before the `await prisma.submission.deleteMany()` line (new tables must be cleared before their foreign key targets):

```ts
export async function truncateAll(): Promise<void> {
  await prisma.balanceLedger.deleteMany();
  await prisma.campaignBalance.deleteMany();
  await prisma.submission.deleteMany();
  await prisma.uploadJob.deleteMany();
  await prisma.task.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.adminAuditLog.deleteMany();
  await prisma.adminUser.deleteMany();
  await prisma.walletNonce.deleteMany();
  await prisma.user.deleteMany();
}
```

- [ ] **Step 2: Add `createCampaignBalance` factory**

In `tests/helpers/factories.ts`, add after `createCampaign`:

```ts
export async function createCampaignBalance(
  campaignId: string,
  balanceWei: bigint = 0n,
) {
  return db.campaignBalance.upsert({
    where: { campaignId },
    create: { campaignId, balanceWei },
    update: { balanceWei },
  });
}
```

- [ ] **Step 3: Run existing tests to confirm helpers still work**

```bash
pnpm test
```

Expected: all existing tests pass. If any fail, the migration or truncate order is wrong — fix before proceeding.

- [ ] **Step 4: Commit**

```bash
git add tests/helpers/db.ts tests/helpers/factories.ts
git commit -m "test: update helpers for CampaignBalance tables (#204)"
```

---

## Task 4: `lib/campaign-balance.ts` + Tests (TDD)

**Files:**
- Create: `lib/campaign-balance.ts`
- Create: `lib/__tests__/campaign-balance.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/__tests__/campaign-balance.test.ts`:

```ts
import { vi, describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createCampaign, createCampaignBalance } from "@/tests/helpers/factories";
import {
  checkAndDebit,
  creditBalance,
  getBalanceSummary,
  InsufficientBalanceError,
  getPlatformFeeWei,
} from "@/lib/campaign-balance";

const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  await truncateAll();
  process.env = { ...ORIGINAL_ENV, PLATFORM_FEE_WEI: "150000000000000000" };
});

// ── getPlatformFeeWei ──────────────────────────────────────────────────────────

describe("getPlatformFeeWei", () => {
  it("parses env var as BigInt", () => {
    process.env.PLATFORM_FEE_WEI = "150000000000000000";
    expect(getPlatformFeeWei()).toBe(150000000000000000n);
  });

  it("throws when env var is missing", () => {
    delete process.env.PLATFORM_FEE_WEI;
    expect(() => getPlatformFeeWei()).toThrow("PLATFORM_FEE_WEI");
  });

  it("throws when env var is not a valid integer string", () => {
    process.env.PLATFORM_FEE_WEI = "not-a-number";
    expect(() => getPlatformFeeWei()).toThrow("PLATFORM_FEE_WEI");
  });
});

// ── creditBalance ──────────────────────────────────────────────────────────────

describe("creditBalance", () => {
  it("creates a CampaignBalance row and DEPOSIT ledger entry on first credit", async () => {
    const campaign = await createCampaign();

    const newBalance = await creditBalance(campaign.id, 1000000000000000000n, "initial top-up");

    expect(newBalance).toBe(1000000000000000000n);

    const balance = await prisma.campaignBalance.findUnique({ where: { campaignId: campaign.id } });
    expect(balance?.balanceWei).toBe(1000000000000000000n);

    const ledger = await prisma.balanceLedger.findMany({ where: { campaignId: campaign.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].type).toBe("DEPOSIT");
    expect(ledger[0].amountWei).toBe(1000000000000000000n);
    expect(ledger[0].note).toBe("initial top-up");
  });

  it("adds to existing balance on subsequent credit", async () => {
    const campaign = await createCampaign();
    await createCampaignBalance(campaign.id, 500000000000000000n);

    const newBalance = await creditBalance(campaign.id, 500000000000000000n);

    expect(newBalance).toBe(1000000000000000000n);
  });

  it("creates DEPOSIT ledger without note when omitted", async () => {
    const campaign = await createCampaign();
    await creditBalance(campaign.id, 100n);

    const ledger = await prisma.balanceLedger.findMany({ where: { campaignId: campaign.id } });
    expect(ledger[0].note).toBeNull();
  });
});

// ── checkAndDebit ──────────────────────────────────────────────────────────────

describe("checkAndDebit", () => {
  it("debits labeler reward + platform fee from balance", async () => {
    const campaign = await createCampaign({ rewardWei: 50000000000000000n });
    await createCampaignBalance(campaign.id, 1000000000000000000n);

    await checkAndDebit(campaign.id, 50000000000000000n, "sub-001");

    const balance = await prisma.campaignBalance.findUnique({ where: { campaignId: campaign.id } });
    // 1e18 - 0.05e18 (reward) - 0.15e18 (fee) = 0.8e18
    expect(balance?.balanceWei).toBe(800000000000000000n);
  });

  it("writes DEBIT_REWARD and DEBIT_FEE ledger entries", async () => {
    const campaign = await createCampaign({ rewardWei: 50000000000000000n });
    await createCampaignBalance(campaign.id, 1000000000000000000n);

    await checkAndDebit(campaign.id, 50000000000000000n, "sub-001");

    const ledger = await prisma.balanceLedger.findMany({
      where: { campaignId: campaign.id },
      orderBy: { type: "asc" },
    });
    expect(ledger).toHaveLength(2);

    const reward = ledger.find((l) => l.type === "DEBIT_REWARD")!;
    expect(reward.amountWei).toBe(50000000000000000n);
    expect(reward.submissionId).toBe("sub-001");

    const fee = ledger.find((l) => l.type === "DEBIT_FEE")!;
    expect(fee.amountWei).toBe(150000000000000000n);
    expect(fee.submissionId).toBe("sub-001");
  });

  it("throws InsufficientBalanceError when balance is too low", async () => {
    const campaign = await createCampaign();
    await createCampaignBalance(campaign.id, 10n); // tiny balance

    await expect(
      checkAndDebit(campaign.id, 50000000000000000n, "sub-002")
    ).rejects.toThrow(InsufficientBalanceError);
  });

  it("throws InsufficientBalanceError when campaign has no balance record", async () => {
    const campaign = await createCampaign();
    // no createCampaignBalance call

    await expect(
      checkAndDebit(campaign.id, 50000000000000000n, "sub-003")
    ).rejects.toThrow(InsufficientBalanceError);
  });

  it("does not debit when balance is exactly equal to required amount", async () => {
    const campaign = await createCampaign();
    const required = 50000000000000000n + 150000000000000000n; // reward + fee
    await createCampaignBalance(campaign.id, required);

    await expect(
      checkAndDebit(campaign.id, 50000000000000000n, "sub-004")
    ).resolves.not.toThrow();

    const balance = await prisma.campaignBalance.findUnique({ where: { campaignId: campaign.id } });
    expect(balance?.balanceWei).toBe(0n);
  });
});

// ── getBalanceSummary ──────────────────────────────────────────────────────────

describe("getBalanceSummary", () => {
  it("returns balanceWei and estimated submissions remaining", async () => {
    const campaign = await createCampaign({ rewardWei: 50000000000000000n });
    await createCampaignBalance(campaign.id, 400000000000000000n);

    // PLATFORM_FEE_WEI=150000000000000000, rewardWei=50000000000000000
    // cost per submission = 200000000000000000 (0.2 cUSD)
    // balance = 400000000000000000 (0.4 cUSD) → 2 submissions
    const summary = await getBalanceSummary(campaign.id, 50000000000000000n);

    expect(summary.balanceWei).toBe(400000000000000000n);
    expect(summary.estimatedSubmissionsRemaining).toBe(2);
  });

  it("returns 0 remaining when no balance row exists", async () => {
    const campaign = await createCampaign();
    const summary = await getBalanceSummary(campaign.id, 50000000000000000n);

    expect(summary.balanceWei).toBe(0n);
    expect(summary.estimatedSubmissionsRemaining).toBe(0);
  });

  it("floors fractional submissions", async () => {
    const campaign = await createCampaign({ rewardWei: 50000000000000000n });
    // 0.3 cUSD balance / 0.2 cUSD per sub = 1.5 → floor to 1
    await createCampaignBalance(campaign.id, 300000000000000000n);

    const summary = await getBalanceSummary(campaign.id, 50000000000000000n);
    expect(summary.estimatedSubmissionsRemaining).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test lib/__tests__/campaign-balance.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/campaign-balance'`

- [ ] **Step 3: Implement `lib/campaign-balance.ts`**

Create `lib/campaign-balance.ts`:

```ts
import prisma from "@/lib/prisma";

export class InsufficientBalanceError extends Error {
  constructor(
    public readonly balanceWei: bigint,
    public readonly requiredWei: bigint,
  ) {
    super(`Campaign balance insufficient: have ${balanceWei}, need ${requiredWei}`);
    this.name = "InsufficientBalanceError";
  }
}

export function getPlatformFeeWei(): bigint {
  const raw = process.env.PLATFORM_FEE_WEI;
  if (!raw || !/^\d+$/.test(raw)) {
    throw new Error("PLATFORM_FEE_WEI env var is required and must be a non-negative integer string");
  }
  return BigInt(raw);
}

export async function checkAndDebit(
  campaignId: string,
  labelerRewardWei: bigint,
  submissionId: string,
): Promise<void> {
  const platformFeeWei = getPlatformFeeWei();
  const required = labelerRewardWei + platformFeeWei;

  await prisma.$transaction(async (tx) => {
    const balance = await tx.campaignBalance.findUnique({
      where: { campaignId },
      select: { balanceWei: true },
    });

    const currentBalance = balance?.balanceWei ?? 0n;

    if (currentBalance < required) {
      throw new InsufficientBalanceError(currentBalance, required);
    }

    const updated = await tx.campaignBalance.updateMany({
      where: { campaignId, balanceWei: { gte: required } },
      data: { balanceWei: { decrement: required } },
    });

    if (updated.count === 0) {
      throw new InsufficientBalanceError(0n, required);
    }

    await tx.balanceLedger.createMany({
      data: [
        { campaignId, type: "DEBIT_REWARD", amountWei: labelerRewardWei, submissionId },
        { campaignId, type: "DEBIT_FEE", amountWei: platformFeeWei, submissionId },
      ],
    });
  });
}

export async function creditBalance(
  campaignId: string,
  amountWei: bigint,
  note?: string,
): Promise<bigint> {
  const result = await prisma.$transaction(async (tx) => {
    const balance = await tx.campaignBalance.upsert({
      where: { campaignId },
      create: { campaignId, balanceWei: amountWei },
      update: { balanceWei: { increment: amountWei } },
    });

    await tx.balanceLedger.create({
      data: { campaignId, type: "DEPOSIT", amountWei, note: note ?? null },
    });

    return balance.balanceWei;
  });

  return result;
}

export async function getBalanceSummary(
  campaignId: string,
  campaignRewardWei: bigint,
): Promise<{ balanceWei: bigint; estimatedSubmissionsRemaining: number }> {
  const balance = await prisma.campaignBalance.findUnique({
    where: { campaignId },
    select: { balanceWei: true },
  });

  const balanceWei = balance?.balanceWei ?? 0n;

  let estimatedSubmissionsRemaining = 0;
  try {
    const platformFeeWei = getPlatformFeeWei();
    const costPerSubmission = campaignRewardWei + platformFeeWei;
    if (costPerSubmission > 0n) {
      estimatedSubmissionsRemaining = Math.floor(Number(balanceWei) / Number(costPerSubmission));
    }
  } catch {
    // PLATFORM_FEE_WEI not configured — estimate unavailable
  }

  return { balanceWei, estimatedSubmissionsRemaining };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test lib/__tests__/campaign-balance.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/campaign-balance.ts lib/__tests__/campaign-balance.test.ts
git commit -m "feat: add campaign-balance lib with checkAndDebit, creditBalance, getBalanceSummary (#204)"
```

---

## Task 5: Deposit API Route

**Files:**
- Create: `app/api/admin/campaigns/[id]/deposit/route.ts`

- [ ] **Step 1: Create the route**

Create `app/api/admin/campaigns/[id]/deposit/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";
import { auditLog } from "@/lib/audit";
import { creditBalance, getBalanceSummary } from "@/lib/campaign-balance";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (session.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id: campaignId } = await params;

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, rewardWei: true },
  });
  if (!campaign) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { amountWei: amountWeiRaw, note } = (body ?? {}) as {
    amountWei?: unknown;
    note?: unknown;
  };

  if (typeof amountWeiRaw !== "string" || !/^\d+$/.test(amountWeiRaw) || amountWeiRaw === "0") {
    return NextResponse.json({ error: "invalid_amount_wei" }, { status: 400 });
  }
  if (note !== undefined && (typeof note !== "string" || note.length > 500)) {
    return NextResponse.json({ error: "invalid_note" }, { status: 400 });
  }

  const amountWei = BigInt(amountWeiRaw);
  const newBalanceWei = await creditBalance(campaignId, amountWei, note as string | undefined);
  const summary = await getBalanceSummary(campaignId, campaign.rewardWei);

  auditLog({
    adminUserId: session.sub,
    action: "campaign.deposit",
    targetType: "campaign",
    targetId: campaignId,
    req,
    metadata: {
      amountWei: amountWeiRaw,
      note: note ?? null,
      newBalanceWei: newBalanceWei.toString(),
    },
  });

  return NextResponse.json({
    balanceWei: newBalanceWei.toString(),
    estimatedSubmissionsRemaining: summary.estimatedSubmissionsRemaining,
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add "app/api/admin/campaigns/[id]/deposit/route.ts"
git commit -m "feat: add POST /api/admin/campaigns/[id]/deposit route (#204)"
```

---

## Task 6: Balance GET API Route

**Files:**
- Create: `app/api/admin/campaigns/[id]/balance/route.ts`

- [ ] **Step 1: Create the route**

Create `app/api/admin/campaigns/[id]/balance/route.ts`:

```ts
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";
import { getBalanceSummary } from "@/lib/campaign-balance";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id: campaignId } = await params;

  const where =
    session.role === "SUPER_ADMIN"
      ? { id: campaignId }
      : { id: campaignId, adminUserId: session.sub };

  const campaign = await prisma.campaign.findFirst({
    where,
    select: { id: true, rewardWei: true },
  });
  if (!campaign) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const summary = await getBalanceSummary(campaignId, campaign.rewardWei);

  const recentLedger = await prisma.balanceLedger.findMany({
    where: { campaignId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      type: true,
      amountWei: true,
      note: true,
      submissionId: true,
      createdAt: true,
    },
  });

  return NextResponse.json({
    balanceWei: summary.balanceWei.toString(),
    estimatedSubmissionsRemaining: summary.estimatedSubmissionsRemaining,
    recentLedger: recentLedger.map((entry) => ({
      type: entry.type,
      amountWei: entry.amountWei.toString(),
      note: entry.note,
      submissionId: entry.submissionId,
      createdAt: entry.createdAt.toISOString(),
    })),
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add "app/api/admin/campaigns/[id]/balance/route.ts"
git commit -m "feat: add GET /api/admin/campaigns/[id]/balance route (#204)"
```

---

## Task 7: Submit Route Changes + Tests

**Files:**
- Modify: `app/api/submit/route.ts`
- Modify: `app/api/submit/__tests__/route.test.ts`

- [ ] **Step 1: Write failing tests first**

Open `app/api/submit/__tests__/route.test.ts`. At the top, add the mock for campaign-balance alongside the existing mocks:

```ts
vi.mock("@/lib/campaign-balance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/campaign-balance")>();
  return {
    ...actual,
    checkAndDebit: vi.fn(),
  };
});
```

Add the import after the other imports from lib:

```ts
import { checkAndDebit, InsufficientBalanceError } from "@/lib/campaign-balance";
```

Add the mock reset in `beforeEach`:

```ts
vi.mocked(checkAndDebit).mockReset();
vi.mocked(checkAndDebit).mockResolvedValue(undefined);
```

Add these new test cases at the end of the file (in a new describe block):

```ts
describe("POST /api/submit - campaign balance", () => {
  it("calls checkAndDebit for non-gold tasks with a campaignId", async () => {
    vi.mocked(payReward).mockResolvedValueOnce("0xabc" as `0x${string}`);
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id });
    const user = await createUser();

    await submit({ walletAddress: user.walletAddress, taskId: task.id, choice: "A", reason: VALID_REASON });

    expect(checkAndDebit).toHaveBeenCalledOnce();
    expect(checkAndDebit).toHaveBeenCalledWith(campaign.id, expect.any(BigInt), expect.any(String));
  });

  it("returns 402 campaign_balance_insufficient when checkAndDebit throws InsufficientBalanceError", async () => {
    vi.mocked(checkAndDebit).mockRejectedValueOnce(
      new InsufficientBalanceError(0n, 200000000000000000n),
    );
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id });
    const user = await createUser();

    const res = await submit({ walletAddress: user.walletAddress, taskId: task.id, choice: "A", reason: VALID_REASON });

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "campaign_balance_insufficient" });
    expect(payReward).not.toHaveBeenCalled();
  });

  it("marks submission as skipped when balance is insufficient", async () => {
    vi.mocked(checkAndDebit).mockRejectedValueOnce(
      new InsufficientBalanceError(0n, 200000000000000000n),
    );
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id });
    const user = await createUser();

    await submit({ walletAddress: user.walletAddress, taskId: task.id, choice: "A", reason: VALID_REASON });

    const submission = await prisma.submission.findFirst({
      where: { walletAddress: user.walletAddress, taskId: task.id },
    });
    expect(submission?.payoutStatus).toBe("skipped");
  });

  it("does not call checkAndDebit for gold tasks", async () => {
    vi.mocked(payReward).mockResolvedValueOnce("0xabc" as `0x${string}`);
    const campaign = await createCampaign();
    const task = await createGoldTask({ campaignId: campaign.id });
    const user = await createUser();

    await submit({ walletAddress: user.walletAddress, taskId: task.id, choice: task.goldAnswer as string, reason: VALID_REASON });

    expect(checkAndDebit).not.toHaveBeenCalled();
  });

  it("does not call checkAndDebit for tasks without a campaign", async () => {
    vi.mocked(payReward).mockResolvedValueOnce("0xabc" as `0x${string}`);
    const task = await createTask({ campaignId: undefined });
    const user = await createUser();

    await submit({ walletAddress: user.walletAddress, taskId: task.id, choice: "A", reason: VALID_REASON });

    expect(checkAndDebit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run new tests to verify they fail**

```bash
pnpm test app/api/submit/__tests__/route.test.ts
```

Expected: FAIL — the balance tests fail because `checkAndDebit` is not yet called in the route.

- [ ] **Step 3: Modify `app/api/submit/route.ts`**

Add the import at the top of the file (after existing imports):

```ts
import { checkAndDebit, InsufficientBalanceError } from "@/lib/campaign-balance";
```

Find the block that starts with:

```ts
    const amount = resolveRewardWei(task.rewardWei, task.campaign?.rewardWei ?? null);
    const submission = await prisma.submission.create({
```

Replace it with:

```ts
    const amount = resolveRewardWei(task.rewardWei, task.campaign?.rewardWei ?? null);
    const submission = await prisma.submission.create({
      data: {
        walletAddress,
        taskId,
        choice,
        reason: reason.trim(),
        isGoldCheck: task.isGold,
        goldPassed: task.isGold ? true : null,
        payoutAmountWei: amount,
        payoutStatus: "pending",
      },
    });

    if (!task.isGold && task.campaignId) {
      try {
        await checkAndDebit(task.campaignId, amount, submission.id);
      } catch (err) {
        if (err instanceof InsufficientBalanceError) {
          await prisma.submission.update({
            where: { id: submission.id },
            data: { payoutStatus: "skipped" },
          });
          return errorResponse("campaign_balance_insufficient", 402, {
            walletAddress,
            taskId,
            campaignId: task.campaignId,
            balanceWei: String(err.balanceWei),
            requiredWei: String(err.requiredWei),
          });
        }
        throw err;
      }
    }
```

Then remove the original `await prisma.submission.create({...})` block that comes right after (the one that was there before — you are splitting the original create + try-catch, inserting the balance check in between). The `try { const txHash = await payReward(...)` block remains as-is below.

> **Note:** The full modified section should read:
> 1. `resolveRewardWei` call
> 2. `submission = await prisma.submission.create(...)` with `payoutStatus: "pending"`  
> 3. Balance check block (new)
> 4. `try { const txHash = await payReward(...)` block (unchanged)

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test app/api/submit/__tests__/route.test.ts
```

Expected: all tests PASS including the new balance tests.

- [ ] **Step 5: Run full test suite**

```bash
pnpm test
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add app/api/submit/route.ts "app/api/submit/__tests__/route.test.ts"
git commit -m "feat: debit campaign balance on submission before payout (#204)"
```

---

## Task 8: BalanceCard Component

**Files:**
- Create: `components/admin/BalanceCard.tsx`

- [ ] **Step 1: Create the component**

Create `components/admin/BalanceCard.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatUnits, parseUnits } from "viem";
import { REWARD_TOKEN_DECIMALS, REWARD_TOKEN_SYMBOL } from "@/lib/constants";

interface LedgerEntry {
  type: "DEPOSIT" | "DEBIT_REWARD" | "DEBIT_FEE" | "REFUND";
  amountWei: string;
  note: string | null;
  submissionId: string | null;
  createdAt: string;
}

interface BalanceCardProps {
  campaignId: string;
  initialBalanceWei: string;
  initialEstimated: number;
  initialLedger: LedgerEntry[];
  isSuperAdmin: boolean;
}

const LEDGER_LABELS: Record<LedgerEntry["type"], string> = {
  DEPOSIT: "Deposit",
  DEBIT_REWARD: "Labeler reward",
  DEBIT_FEE: "Platform fee",
  REFUND: "Refund",
};

const LOW_BALANCE_THRESHOLD = 100;

export default function BalanceCard({
  campaignId,
  initialBalanceWei,
  initialEstimated,
  initialLedger,
  isSuperAdmin,
}: BalanceCardProps) {
  const router = useRouter();
  const [balanceWei, setBalanceWei] = useState(initialBalanceWei);
  const [estimated, setEstimated] = useState(initialEstimated);
  const [ledger, setLedger] = useState(initialLedger);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const balanceFormatted = formatUnits(BigInt(balanceWei), REWARD_TOKEN_DECIMALS);
  const isLowBalance = estimated < LOW_BALANCE_THRESHOLD;

  async function handleDeposit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    let amountWei: bigint;
    try {
      amountWei = parseUnits(amount, REWARD_TOKEN_DECIMALS);
      if (amountWei <= 0n) throw new Error();
    } catch {
      setError("Enter a valid positive amount.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/admin/campaigns/${campaignId}/deposit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountWei: amountWei.toString(), note: note || undefined }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Deposit failed. Try again.");
        return;
      }

      const data = await res.json();
      setBalanceWei(data.balanceWei);
      setEstimated(data.estimatedSubmissionsRemaining);
      setAmount("");
      setNote("");

      // Refresh ledger
      const ledgerRes = await fetch(`/api/admin/campaigns/${campaignId}/balance`);
      if (ledgerRes.ok) {
        const ledgerData = await ledgerRes.json();
        setLedger(ledgerData.recentLedger);
      }

      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-2xl border border-outline-variant bg-surface-container-low p-6 space-y-4">
      <h2 className="font-headline text-lg font-semibold text-on-surface">Campaign Balance</h2>

      {isLowBalance && (
        <div className="rounded-lg bg-amber-50 border border-amber-300 px-4 py-2 text-sm text-amber-800">
          Low balance — approximately {estimated} submission{estimated !== 1 ? "s" : ""} remaining.
          {isSuperAdmin ? " Credit the balance below." : " Contact your account manager to top up."}
        </div>
      )}

      <div className="flex gap-8">
        <div>
          <p className="text-xs text-on-surface-variant uppercase tracking-wide">Balance</p>
          <p className="text-2xl font-bold text-on-surface">
            {Number(balanceFormatted).toFixed(2)} {REWARD_TOKEN_SYMBOL}
          </p>
        </div>
        <div>
          <p className="text-xs text-on-surface-variant uppercase tracking-wide">Est. submissions</p>
          <p className="text-2xl font-bold text-on-surface">{estimated.toLocaleString()}</p>
        </div>
      </div>

      {isSuperAdmin && (
        <form onSubmit={handleDeposit} className="space-y-3 pt-2 border-t border-outline-variant">
          <p className="text-sm font-medium text-on-surface">Credit Balance</p>
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <label className="block text-xs text-on-surface-variant mb-1">
                Amount ({REWARD_TOKEN_SYMBOL})
              </label>
              <input
                type="number"
                min="0.000001"
                step="any"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                required
                className="w-full rounded-lg border border-outline bg-surface px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs text-on-surface-variant mb-1">
                Memo (optional)
              </label>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                placeholder="e.g. Invoice #123"
                className="w-full rounded-lg border border-outline bg-surface px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "Crediting…" : "Credit"}
            </button>
          </div>
          {error && <p className="text-xs text-error">{error}</p>}
        </form>
      )}

      {ledger.length > 0 && (
        <div className="pt-2 border-t border-outline-variant">
          <p className="text-xs font-medium text-on-surface-variant uppercase tracking-wide mb-2">Recent Activity</p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-on-surface-variant">
                <th className="pb-1 font-medium">Type</th>
                <th className="pb-1 font-medium">Amount</th>
                <th className="pb-1 font-medium">Note</th>
                <th className="pb-1 font-medium">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {ledger.map((entry, i) => (
                <tr key={i}>
                  <td className="py-1 text-on-surface">{LEDGER_LABELS[entry.type]}</td>
                  <td className="py-1 text-on-surface">
                    {entry.type === "DEPOSIT" ? "+" : "−"}
                    {Number(formatUnits(BigInt(entry.amountWei), REWARD_TOKEN_DECIMALS)).toFixed(4)}{" "}
                    {REWARD_TOKEN_SYMBOL}
                  </td>
                  <td className="py-1 text-on-surface-variant">{entry.note ?? "—"}</td>
                  <td className="py-1 text-on-surface-variant">
                    {new Date(entry.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ledger.length === 0 && (
        <p className="text-sm text-on-surface-variant">No transactions yet.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add components/admin/BalanceCard.tsx
git commit -m "feat: add BalanceCard component for campaign balance display (#204)"
```

---

## Task 9: Wire BalanceCard into CampaignDetail + Page

**Files:**
- Modify: `components/admin/CampaignDetail.tsx`
- Modify: `app/admin/(protected)/campaigns/[id]/page.tsx`

- [ ] **Step 1: Add BalanceCard to CampaignDetail**

Open `components/admin/CampaignDetail.tsx`. At the top, add the import:

```ts
import BalanceCard from "@/components/admin/BalanceCard";
```

Update the `CampaignDetailProps` interface to include balance props. Find the interface definition and add:

```ts
interface CampaignDetailProps {
  campaignId: string;
  campaignName: string;
  defaultResponseTarget: number;
  rewardWei: string;
  pausedAt: string | null;
  ownerEmail: string | null;
  isReadOnly: boolean;
  canManage: boolean;
  // new
  balanceWei: string;
  estimatedSubmissionsRemaining: number;
  recentLedger: Array<{
    type: "DEPOSIT" | "DEBIT_REWARD" | "DEBIT_FEE" | "REFUND";
    amountWei: string;
    note: string | null;
    submissionId: string | null;
    createdAt: string;
  }>;
  isSuperAdmin: boolean;
}
```

In the component function signature, destructure the new props:

```ts
export default function CampaignDetail({
  campaignId,
  campaignName,
  defaultResponseTarget,
  rewardWei,
  pausedAt,
  ownerEmail,
  isReadOnly,
  canManage,
  balanceWei,
  estimatedSubmissionsRemaining,
  recentLedger,
  isSuperAdmin,
}: CampaignDetailProps) {
```

Find the return JSX. Add `<BalanceCard>` as the first child inside the outermost wrapping `<div className="space-y-6">` (or wherever the other cards/sections are rendered — place it right after the campaign header/stats section):

```tsx
<BalanceCard
  campaignId={campaignId}
  initialBalanceWei={balanceWei}
  initialEstimated={estimatedSubmissionsRemaining}
  initialLedger={recentLedger}
  isSuperAdmin={isSuperAdmin}
/>
```

- [ ] **Step 2: Update the campaign detail page to fetch balance**

Open `app/admin/(protected)/campaigns/[id]/page.tsx`. Add the import:

```ts
import { getBalanceSummary } from "@/lib/campaign-balance";
import prisma from "@/lib/prisma";
```

(Note: `prisma` is already imported — skip if already present.)

After fetching `campaign`, add:

```ts
  const balanceSummary = await getBalanceSummary(id, campaign.rewardWei);

  const recentLedger = await prisma.balanceLedger.findMany({
    where: { campaignId: id },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      type: true,
      amountWei: true,
      note: true,
      submissionId: true,
      createdAt: true,
    },
  });
```

Pass the new props to `<CampaignDetail>`:

```tsx
  return (
    <CampaignDetail
      campaignId={id}
      campaignName={campaign.name}
      defaultResponseTarget={campaign.defaultResponseTarget}
      rewardWei={campaign.rewardWei.toString()}
      pausedAt={campaign.pausedAt?.toISOString() ?? null}
      ownerEmail={campaign.adminUser.companyName ?? campaign.adminUser.email}
      isReadOnly={isReadOnly}
      canManage={canManage}
      balanceWei={balanceSummary.balanceWei.toString()}
      estimatedSubmissionsRemaining={balanceSummary.estimatedSubmissionsRemaining}
      recentLedger={recentLedger.map((e) => ({
        type: e.type as "DEPOSIT" | "DEBIT_REWARD" | "DEBIT_FEE" | "REFUND",
        amountWei: e.amountWei.toString(),
        note: e.note,
        submissionId: e.submissionId,
        createdAt: e.createdAt.toISOString(),
      }))}
      isSuperAdmin={session.role === "SUPER_ADMIN"}
    />
  );
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors. If there are type errors, fix them (usually missing `@map` on the `BalanceLedger` `type` field — cast as needed).

- [ ] **Step 4: Run full test suite**

```bash
pnpm test
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add components/admin/CampaignDetail.tsx "app/admin/(protected)/campaigns/[id]/page.tsx"
git commit -m "feat: add BalanceCard to campaign detail page (#204)"
```

---

## Task 10: Env + Coverage Config

**Files:**
- Modify: `.env.local.example`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Document `PLATFORM_FEE_WEI` in `.env.local.example`**

Open `.env.local.example` and add at the end:

```
# Platform fee deducted from campaign balance per submission (in wei, 18 decimals).
# Required when campaign balance is enabled. $0.15 cUSD = 150000000000000000
PLATFORM_FEE_WEI=150000000000000000
```

- [ ] **Step 2: Add coverage thresholds**

Open `vitest.config.ts`. Inside the `thresholds` object, add:

```ts
"lib/campaign-balance.ts": {
  lines: 85,
  functions: 85,
  branches: 80,
  statements: 85,
},
```

- [ ] **Step 3: Verify coverage**

```bash
pnpm test:coverage 2>&1 | grep -A 5 "campaign-balance"
```

Expected: coverage meets or exceeds the thresholds above.

- [ ] **Step 4: Commit**

```bash
git add .env.local.example vitest.config.ts
git commit -m "chore: document PLATFORM_FEE_WEI and add coverage threshold for campaign-balance (#204)"
```

---

## Task 11: Create PR

**Files:** none

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/204-campaign-balance
```

- [ ] **Step 2: Create PR linked to issue #204, targeting develop**

```bash
gh pr create \
  --base develop \
  --title "feat: prepaid campaign balance with per-submission debit (#204)" \
  --body "$(cat <<'EOF'
## Summary

- Adds `CampaignBalance` and `BalanceLedger` Prisma models (off-chain accounting)
- `lib/campaign-balance.ts` — `checkAndDebit`, `creditBalance`, `getBalanceSummary`, `InsufficientBalanceError`
- `POST /api/submit` debits campaign balance (reward + platform fee) atomically before payout; returns 402 if insufficient
- `POST /api/admin/campaigns/[id]/deposit` — SUPER_ADMIN credits balance with audit log
- `GET /api/admin/campaigns/[id]/balance` — returns balance summary + recent ledger
- `BalanceCard` component on campaign detail page: balance, estimated submissions remaining, low-balance warning, deposit form for SUPER_ADMIN

Closes #204

## Test plan

- [ ] `pnpm test` passes
- [ ] `pnpm test:coverage` meets thresholds for `lib/campaign-balance.ts`
- [ ] Manually credit a campaign balance as SUPER_ADMIN via campaign detail page
- [ ] Submit a task against a campaign with sufficient balance — verify debit ledger entries created
- [ ] Submit a task against a campaign with zero balance — verify 402 response and submission marked skipped
- [ ] Verify low-balance warning banner appears when < 100 submissions remaining
- [ ] Verify CUSTOMER role cannot access deposit endpoint (403)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed to stdout. The `Closes #204` in the body auto-links and closes the issue on merge.

---

## Self-Review

**Spec coverage check:**
- ✅ `CampaignBalance` + `BalanceLedger` tables — Task 2
- ✅ `POST /api/submit` checks balance atomically — Task 7
- ✅ 402 on insufficient balance — Task 7
- ✅ Customer dashboard balance card — Tasks 8 & 9
- ✅ Low-balance warning (< 100) — Task 8 (`BalanceCard`)
- ✅ SUPER_ADMIN deposit API — Task 5
- ✅ Full ledger audit trail — Tasks 4, 5, 6
- ✅ `PLATFORM_FEE_WEI` env var — Task 4 (`getPlatformFeeWei`) + Task 10
- ✅ Feature branch + PR linked to issue — Tasks 1 & 11

**Placeholder scan:** No TBDs. All code blocks are complete.

**Type consistency:**
- `checkAndDebit(campaignId, labelerRewardWei, submissionId)` — consistent across Task 4 (impl), Task 7 (mock + call)
- `getBalanceSummary(campaignId, campaignRewardWei)` — consistent across Task 4 (impl), Task 9 (page call)
- `creditBalance(campaignId, amountWei, note?)` — consistent across Task 4 (impl), Task 5 (route call)
- `LedgerEntry` interface in `BalanceCard` matches the shape returned by the GET API and the page query
- `InsufficientBalanceError` imported and used identically in Task 4 (tests), Task 7 (route + mock)

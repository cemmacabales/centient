import { PrismaClient } from "@/app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "TEST_DATABASE_URL or DATABASE_URL must be set for integration tests",
  );
}

const globalForPrisma = globalThis as unknown as { __testPrisma: PrismaClient };

const adapter = new PrismaPg({ connectionString });

export const prisma =
  globalForPrisma.__testPrisma ??
  new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__testPrisma = prisma;
}

export async function truncateAll(): Promise<void> {
  const P2021 = "P2021";
  const tryDelete = async (fn: () => unknown) => {
    try {
      await fn();
    } catch (err: any) {
      if (err?.code !== P2021) throw err;
    }
  };

  await tryDelete(() => prisma.xpEvent.deleteMany());
  await tryDelete(() => prisma.inviteReward.deleteMany());
  await tryDelete(() => prisma.eventRedemption.deleteMany());
  await tryDelete(() => prisma.eventCode.deleteMany());
  await tryDelete(() => prisma.weeklyResult.deleteMany());
  await tryDelete(() => prisma.boardWeek.deleteMany());
  await tryDelete(() => prisma.retiredDisplayName.deleteMany());
  await tryDelete(() => prisma.dailyProgress.deleteMany());
  await tryDelete(() => prisma.flaggedWithdrawal.deleteMany());
  await tryDelete(() => prisma.bannedIdentity.deleteMany());
  await tryDelete(() => prisma.userIdentifierHistory.deleteMany());
  await tryDelete(() => prisma.balanceLedger.deleteMany());
  await tryDelete(() => prisma.campaignBalance.deleteMany());
  await tryDelete(() => prisma.payoutAttempt.deleteMany());
  await tryDelete(() => prisma.submission.deleteMany());
  await tryDelete(() => prisma.payoutJob.deleteMany());
  await tryDelete(() => prisma.uploadJob.deleteMany());
  await tryDelete(() => prisma.task.deleteMany());
  await tryDelete(() => prisma.campaign.deleteMany());
  await tryDelete(() => prisma.adminAuditLog.deleteMany());
  await tryDelete(() => prisma.adminUser.deleteMany());
  await tryDelete(() => prisma.walletNonce.deleteMany());
  await tryDelete(() => prisma.sponsoredTrustline.deleteMany());
  await tryDelete(() => prisma.sponsorshipReclaimRun.deleteMany());
  await tryDelete(() => prisma.user.deleteMany());
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}

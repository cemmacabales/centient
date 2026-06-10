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
  await prisma.submission.deleteMany();
  await prisma.payoutJob.deleteMany();
  await prisma.uploadJob.deleteMany();
  await prisma.task.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.adminAuditLog.deleteMany();
  await prisma.adminUser.deleteMany();
  await prisma.walletNonce.deleteMany();
  await prisma.user.deleteMany();
}
  };

  await tryDelete(() => prisma.submission.deleteMany());
  await tryDelete(() => prisma.payoutJob.deleteMany());
  await tryDelete(() => prisma.uploadJob.deleteMany());
  await tryDelete(() => prisma.task.deleteMany());
  await tryDelete(() => prisma.campaign.deleteMany());
  await tryDelete(() => prisma.adminAuditLog.deleteMany());
  await tryDelete(() => prisma.adminUser.deleteMany());
  await tryDelete(() => prisma.walletNonce.deleteMany());
  await tryDelete(() => prisma.user.deleteMany());
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}

import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = global as unknown as { prisma: PrismaClient };

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

const logQueries = process.env.LOG_QUERIES === "1";

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter,
    log: logQueries
      ? [
          { emit: "stdout", level: "query" },
          { emit: "stdout", level: "warn" },
          { emit: "stdout", level: "error" },
        ]
      : [
          { emit: "stdout", level: "warn" },
          { emit: "stdout", level: "error" },
        ],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export default prisma;

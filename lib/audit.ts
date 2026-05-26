import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";

export interface AuditLogParams {
  adminUserId: string;
  action: string;
  targetType: string;
  targetId?: string;
  metadata?: Prisma.InputJsonValue;
  req?: NextRequest;
}

export function auditLog({
  adminUserId,
  action,
  targetType,
  targetId,
  metadata,
  req,
}: AuditLogParams): void {
  let ipAddress: string | null = null;
  let userAgent: string | null = null;

  if (req) {
    const forwardedFor = req.headers.get("x-forwarded-for");
    ipAddress = forwardedFor ? forwardedFor.split(",")[0].trim() : null;
    userAgent = req.headers.get("user-agent");
  }

  prisma.adminAuditLog
    .create({
      data: {
        adminUserId,
        action,
        targetType,
        targetId: targetId || null,
        metadata: metadata ?? Prisma.JsonNull, 
        ipAddress,
        userAgent,
      },
    })
    .catch((error) => {
      console.error(`[AUDIT_LOG_ERROR] Failed to log action ${action}:`, error);
    });
}
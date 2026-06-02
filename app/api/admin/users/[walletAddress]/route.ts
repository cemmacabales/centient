import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { getUserProfile } from "@/lib/admin-data";
import { auditLog } from "@/lib/audit";

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ walletAddress: string }> },
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const forbidden = await requireRoleForRoute("SUPER_ADMIN", session);
  if (forbidden) return forbidden;

  const { walletAddress } = await params;
  if (!WALLET_RE.test(walletAddress)) {
    return NextResponse.json({ error: "invalid_wallet" }, { status: 400 });
  }

  const profile = await getUserProfile(walletAddress);
  if (!profile) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({
    ...profile,
    createdAt: profile.createdAt.toISOString(),
    bannedAt: profile.bannedAt?.toISOString() ?? null,
    totalEarnedWei: profile.totalEarnedWei.toString(),
    recentSubmissions: profile.recentSubmissions.map((s) => ({
      ...s,
      payoutAmountWei: s.payoutAmountWei.toString(),
      createdAt: s.createdAt.toISOString(),
    })),
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ walletAddress: string }> },
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const forbidden = await requireRoleForRoute("SUPER_ADMIN", session);
  if (forbidden) return forbidden;

  const { walletAddress } = await params;
  if (!WALLET_RE.test(walletAddress)) {
    return NextResponse.json({ error: "invalid_wallet" }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    reason?: string;
  };

  if (body.action !== "ban" && body.action !== "unban") {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : null;

  const before = await prisma.user.findUnique({
    where: { walletAddress: walletAddress.toLowerCase() },
    select: { isBanned: true, bannedAt: true, bannedReason: true },
  });
  if (!before) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (body.action === "ban" && before.isBanned) {
    return NextResponse.json({ error: "already_banned" }, { status: 409 });
  }
  if (body.action === "unban" && !before.isBanned) {
    return NextResponse.json({ error: "not_banned" }, { status: 409 });
  }

  const after = await prisma.user.update({
    where: { walletAddress: walletAddress.toLowerCase() },
    data:
      body.action === "ban"
        ? {
            isBanned: true,
            bannedAt: new Date(),
            bannedReason: reason ?? "operator: manual ban",
          }
        : {
            isBanned: false,
            bannedAt: null,
            bannedReason: null,
          },
  });

  auditLog({
    adminUserId: session.sub,
    action: body.action === "ban" ? "user.ban" : "user.unban",
    targetType: "user",
    targetId: after.walletAddress,
    req,
    metadata: {
      before: {
        isBanned: before.isBanned,
        bannedAt: before.bannedAt?.toISOString() ?? null,
        bannedReason: before.bannedReason,
      },
      after: {
        isBanned: after.isBanned,
        bannedAt: after.bannedAt?.toISOString() ?? null,
        bannedReason: after.bannedReason,
      },
    },
  });

  return NextResponse.json({
    walletAddress: after.walletAddress,
    isBanned: after.isBanned,
    bannedAt: after.bannedAt?.toISOString() ?? null,
    bannedReason: after.bannedReason,
  });
}

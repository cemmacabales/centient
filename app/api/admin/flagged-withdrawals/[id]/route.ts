import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { auditLog } from "@/lib/audit";
import { addBannedIdentity } from "@/lib/ban-identity";
import { isValidStellarAddress } from "@/lib/stellar/signature";

/**
 * P4c — resolve a flagged withdrawal.
 *
 * Actions:
 *  - "approve": clear the flag so the labeler may retry the withdrawal.
 *  - "reject":  dismiss the attempt without banning.
 *  - "ban":     dismiss the attempt AND ban the account — sets `isBanned` and adds
 *               the account's email / wallet / userId to the ban list (P4b binding)
 *               so the same identities are blocked at the next withdrawal. Because a
 *               ban is irreversible-ish and high-impact, the request MUST carry
 *               `confirm: true` (UI confirmation safeguard, enforced server-side too).
 *
 * Every resolution is written to AdminAuditLog.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const forbidden = await requireRoleForRoute("SUPER_ADMIN", session);
  if (forbidden) return forbidden;

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    note?: string;
    confirm?: boolean;
  };

  if (body.action !== "approve" && body.action !== "reject" && body.action !== "ban") {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) || null : null;

  const flag = await prisma.flaggedWithdrawal.findUnique({
    where: { id },
    include: { user: { select: { id: true, email: true, walletAddress: true } } },
  });
  if (!flag) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (flag.status !== "PENDING") {
    return NextResponse.json({ error: "already_resolved" }, { status: 409 });
  }

  if (body.action === "ban" && body.confirm !== true) {
    return NextResponse.json({ error: "confirmation_required" }, { status: 400 });
  }

  const resolvedStatus = body.action === "approve" ? "APPROVED" : "REJECTED";

  const updated = await prisma.flaggedWithdrawal.update({
    where: { id },
    data: {
      status: resolvedStatus,
      resolvedByAdminId: session.sub,
      resolvedAt: new Date(),
      resolutionNote: note,
    },
  });

  if (body.action === "ban") {
    // Ban the account and bind the ban to every identifier on it (P4b), so the
    // next withdrawal from the same email/wallet/account is blocked at the gate.
    await prisma.user.update({
      where: { id: flag.userId },
      data: {
        isBanned: true,
        bannedAt: new Date(),
        bannedReason: note ?? `flagged withdrawal: ${flag.reason}`,
        banCount: { increment: 1 },
        bannedUntil: null,
        lastBanAt: new Date(),
      },
    });

    const banReason = note ?? `flagged withdrawal: ${flag.reason}`;
    if (flag.user.email) {
      await addBannedIdentity("EMAIL", flag.user.email, banReason);
    }
    if (flag.user.walletAddress && isValidStellarAddress(flag.user.walletAddress)) {
      // Case-preserved `G…` StrKey — lowercasing would store an un-matchable ban
      // that the case-sensitive lookup could never hit (ST-4d). A malformed stored
      // address is skipped: it can never match a well-formed withdrawal destination,
      // and calling addBannedIdentity with it would throw here — after the flag and
      // user rows are already written — leaving a partial ban and a 500.
      await addBannedIdentity("WALLET", flag.user.walletAddress, banReason);
    }
    await addBannedIdentity("USER_ID", flag.userId, banReason);

    auditLog({
      adminUserId: session.sub,
      action: "user.ban",
      targetType: "user",
      targetId: flag.userId,
      req,
      metadata: { source: "flagged_withdrawal", flaggedWithdrawalId: id, reason: flag.reason },
    });
  }

  auditLog({
    adminUserId: session.sub,
    action: `flagged_withdrawal.${body.action}`,
    targetType: "flaggedWithdrawal",
    targetId: id,
    req,
    metadata: {
      userId: flag.userId,
      reason: flag.reason,
      walletAddress: flag.walletAddress,
      note,
    },
  });

  return NextResponse.json({
    id: updated.id,
    status: updated.status,
    resolvedAt: updated.resolvedAt?.toISOString() ?? null,
  });
}

// Display names against the database (#203, ADR-0012). The rules for a name are
// in names.ts. A name is opt-in: nothing shows until the labeler sets one and
// turns "Show my name" on. An admin hide retires the name, so nobody can choose
// it again, and asks its owner for another.

import prisma from "@/lib/prisma";
import { validateDisplayName, type NameRejection } from "./names";
import { captureServer } from "./server-analytics";

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "P2002";
}

export interface NameSettingsView {
  displayName: string | null;
  showOnBoard: boolean;
  /** An admin hid the last name: ask for another. */
  nameHidden: boolean;
}

export type ProfileError = NameRejection | "name_taken" | "name_retired" | "name_required" | "invalid";

export type ProfileResult = { ok: true; settings: NameSettingsView } | { ok: false; error: ProfileError };

const select = { displayName: true, showOnBoard: true, displayNameHiddenAt: true } as const;

/** Set the name, "Show my name", or both. Null when the account is gone. */
export async function setBoardProfile(
  userId: string,
  body: { displayName?: unknown; showOnBoard?: unknown },
): Promise<ProfileResult | null> {
  const data: { displayName?: string; displayNameHiddenAt?: null; showOnBoard?: boolean } = {};
  let name: string | undefined;
  if (body.displayName !== undefined) {
    const checked = validateDisplayName(body.displayName);
    if (!checked.ok) return { ok: false, error: checked.reason };
    name = checked.name;
  }
  if (body.showOnBoard !== undefined) {
    if (typeof body.showOnBoard !== "boolean") return { ok: false, error: "invalid" };
    data.showOnBoard = body.showOnBoard;
  }

  let result: ProfileResult | null;
  try {
    // The row is held like hideDisplayName holds it, so a name retired by a
    // hide that commits first is refused here, never written back.
    result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId }, select });
      if (!user) return null;
      if (name !== undefined) {
        if (await tx.retiredDisplayName.findUnique({ where: { name } })) return { ok: false, error: "name_retired" } as const;
        data.displayName = name;
        data.displayNameHiddenAt = null;
      }
      const showOnBoard = data.showOnBoard ?? user.showOnBoard;
      if (showOnBoard && !(data.displayName ?? user.displayName)) return { ok: false, error: "name_required" } as const;
      const saved = await tx.user.update({ where: { id: userId }, data, select });
      return {
        ok: true,
        settings: { displayName: saved.displayName, showOnBoard: saved.showOnBoard, nameHidden: saved.displayNameHiddenAt !== null },
      } as const;
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: "name_taken" };
    throw err;
  }

  if (result?.ok && data.displayName !== undefined) captureServer(userId, "display_name_set", { shown: result.settings.showOnBoard });
  return result;
}

/** An admin hides a labeler's name. Null when there's no name to hide. */
export async function hideDisplayName(userId: string, at: Date = new Date()): Promise<{ name: string } | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId }, select: { displayName: true } });
    if (!user?.displayName) return null;
    await tx.retiredDisplayName.createMany({ data: [{ name: user.displayName, retiredAt: at }], skipDuplicates: true });
    await tx.user.update({
      where: { id: userId },
      data: { displayName: null, showOnBoard: false, displayNameHiddenAt: at },
    });
    return { name: user.displayName };
  });
}

import { NextRequest, NextResponse } from "next/server";
import { getLabelerSession } from "@/lib/labeler-auth";
import { setBoardProfile, type ProfileError } from "@/lib/gamification/profile";

// #203: the labeler's board name and "Show my name". Names are opt-in, unique
// and filtered (lib/gamification/names.ts).

const STATUS: Partial<Record<ProfileError, number>> = { name_taken: 409, name_retired: 409 };

export async function PATCH(req: NextRequest) {
  const userId = await getLabelerSession(req);
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const result = await setBoardProfile(userId, body);
  if (!result) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: STATUS[result.error] ?? 400 });
  }
  return NextResponse.json(result.settings);
}

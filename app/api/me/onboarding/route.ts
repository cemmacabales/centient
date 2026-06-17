import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { COUNTRIES } from "@/lib/countries";
import { getLabelerSession, requireLabelerSession } from "@/lib/labeler-auth";

export async function POST(req: NextRequest) {
  const userId = await getLabelerSession(req);
  const unauthorized = requireLabelerSession(userId);
  if (unauthorized) return unauthorized;

  let body: { country?: string; ageRange?: string; gender?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { country, ageRange, gender } = body;

  if (!country || !ageRange) {
    return NextResponse.json(
      { error: "missing_required_fields", message: "country and ageRange are required" },
      { status: 400 }
    );
  }

  const validCountryCodes = COUNTRIES.map((c) => c.code) as string[];
  if (!validCountryCodes.includes(country.toUpperCase())) {
    return NextResponse.json({ error: "invalid_country" }, { status: 400 });
  }

  const validAgeRanges = ["18-24", "25-34", "35-44", "45-54", "55+"];
  if (!validAgeRanges.includes(ageRange)) {
    return NextResponse.json({ error: "invalid_age_range" }, { status: 400 });
  }

  const validGenders = ["male", "female", "prefer_not_to_say"];
  if (gender && !validGenders.includes(gender.toLowerCase())) {
    return NextResponse.json({ error: "invalid_gender" }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({
    where: { id: userId! },
    select: { onboardingCompleted: true },
  });

  if (!existing) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (existing.onboardingCompleted) {
    return NextResponse.json({ error: "onboarding_already_completed" }, { status: 409 });
  }

  await prisma.user.update({
    where: { id: userId! },
    data: {
      country: country.toUpperCase(),
      ageRange,
      gender: gender ? gender.toLowerCase() : null,
      onboardingCompleted: true,
    },
  });

  return NextResponse.json({ success: true });
}

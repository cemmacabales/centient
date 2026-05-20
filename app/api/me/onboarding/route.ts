import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { COUNTRIES } from "@/lib/countries";

export async function POST(req: NextRequest) {
  let body: { wallet?: string; country?: string; ageRange?: string; gender?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const wallet = body.wallet?.toLowerCase();
  if (!wallet || !/^0x[a-f0-9]{40}$/.test(wallet)) {
    return NextResponse.json({ error: "invalid_wallet" }, { status: 400 });
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
    where: { walletAddress: wallet },
    select: { onboardingCompleted: true },
  });

  if (existing?.onboardingCompleted) {
    return NextResponse.json({ error: "onboarding_already_completed" }, { status: 409 });
  }

  await prisma.user.upsert({
    where: { walletAddress: wallet },
    create: {
      walletAddress: wallet,
      country: country.toUpperCase(),
      ageRange,
      gender: gender ? gender.toLowerCase() : null,
      onboardingCompleted: true,
    },
    update: {
      country: country.toUpperCase(),
      ageRange,
      gender: gender ? gender.toLowerCase() : null,
      onboardingCompleted: true,
    },
  });

  return NextResponse.json({ success: true });
}
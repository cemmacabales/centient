import { NextResponse } from "next/server";
import { deployedBuild } from "@/lib/build-info";
import { stellarNetwork } from "@/lib/stellar/config";

export const dynamic = "force-dynamic";

/**
 * Public build identity (#48): the commit this deployment was built from and the
 * Stellar network it runs on. `sha` is null for a build with no deployment SHA,
 * never a guess. Holds nothing a reviewer cannot already read on the mirror.
 */
export async function GET() {
  const build = deployedBuild();
  return NextResponse.json(
    {
      sha: build?.sha ?? null,
      shortSha: build?.shortSha ?? null,
      commitUrl: build?.commitUrl ?? null,
      network: stellarNetwork(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

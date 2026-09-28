import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/health-alert", () => ({ sendDedupedDiscordAlert: vi.fn(async () => "sent") }));

import { sendDedupedDiscordAlert } from "@/lib/health-alert";
import { coSignerDeferralAlert, raiseCoSignerDeferralAlert } from "@/lib/payout-deferral";
import { CoSignerCapError, CoSignerUnavailableError } from "@/lib/stellar/cosigner-errors";

describe("co-signer deferral alerts (#47)", () => {
  it("pages under its own identity when the co-signer is unavailable", () => {
    const alert = coSignerDeferralAlert(new CoSignerUnavailableError("payout co-signer unreachable: timed out after 10000ms"));

    expect(alert).toMatchObject({ key: "cosigner-unavailable", severity: "PAGE" });
    expect(alert.lines[0]).toContain("timed out");
    expect(alert.lines.join(" ")).toMatch(/nothing is refunded/i);
  });

  it("pages under a separate identity from the service's own cap alert", () => {
    const alert = coSignerDeferralAlert(new CoSignerCapError("payout co-signer refused: daily cap reached"));

    expect(alert).toMatchObject({ key: "cosigner-cap", severity: "PAGE" });
    expect(alert.key).not.toBe("payout-cap");
  });

  it("never lets a failed delivery reach the payer", async () => {
    vi.mocked(sendDedupedDiscordAlert).mockRejectedValueOnce(new Error("redis down"));

    expect(() => raiseCoSignerDeferralAlert(new CoSignerUnavailableError("down"))).not.toThrow();
    await Promise.resolve();
  });
});

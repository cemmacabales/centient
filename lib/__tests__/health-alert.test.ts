import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockDel, mockSet } = vi.hoisted(() => ({
  mockDel: vi.fn(),
  mockSet: vi.fn(),
}));

vi.mock("../redis", () => ({
  redis: {
    del: mockDel,
    set: mockSet,
  },
}));

import { sendDedupedDiscordAlert } from "../health-alert";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV, DISCORD_WEBHOOK_URL: "https://discord.test/webhook" };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe("sendDedupedDiscordAlert", () => {
  it("acquires one atomic Redis cooldown before delivering an alert", async () => {
    mockSet.mockResolvedValueOnce("OK");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendDedupedDiscordAlert(
      {
        key: "wallet-usdc-page",
        severity: "PAGE",
        title: "USDC reward balance is low",
        lines: ["5.00 USDC remains"],
      },
      { cooldownMs: 900_000, nowMs: 1_700_000_000_000 },
    );

    expect(result).toBe("sent");
    expect(mockSet).toHaveBeenCalledWith(
      "t2p:health-alert:wallet-usdc-page",
      "1700000000000",
      "PX",
      900_000,
      "NX",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0][1];
    expect(JSON.parse(String(request.body))).toMatchObject({
      embeds: [{ title: "USDC reward balance is low" }],
    });
  });

  it("suppresses delivery when another process owns the cooldown", async () => {
    mockSet.mockResolvedValueOnce(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendDedupedDiscordAlert({
      key: "wallet-xlm-page",
      severity: "PAGE",
      title: "XLM fee balance is low",
      lines: ["1.00 XLM remains"],
    });

    expect(result).toBe("suppressed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("releases the cooldown when Discord rejects the alert", async () => {
    mockSet.mockResolvedValueOnce("OK");
    mockDel.mockResolvedValueOnce(1);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendDedupedDiscordAlert({
      key: "payout-cap",
      severity: "WARN",
      title: "Daily payout cap is approaching",
      lines: ["80% consumed"],
    });

    expect(result).toBe("failed");
    expect(mockDel).toHaveBeenCalledWith("t2p:health-alert:payout-cap");
    consoleError.mockRestore();
  });
});

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockDel, mockEval, mockSet } = vi.hoisted(() => ({
  mockDel: vi.fn(),
  mockEval: vi.fn(),
  mockSet: vi.fn(),
}));

vi.mock("../redis", () => ({
  redis: {
    del: mockDel,
    eval: mockEval,
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sendDedupedDiscordAlert", () => {
  it("promotes an owned 30-second delivery lease to the configured cooldown after delivery", async () => {
    mockSet.mockResolvedValueOnce("OK");
    mockEval.mockResolvedValueOnce(1);
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

    const redisKey = "t2p:health-alert:wallet-usdc-page";
    const token = mockSet.mock.calls[0][1];
    expect(result).toBe("sent");
    expect(mockSet).toHaveBeenCalledWith(redisKey, expect.any(String), "PX", 30_000, "NX");
    expect(token).not.toBe("1700000000000");
    expect(mockEval).toHaveBeenCalledWith(
      expect.stringContaining("psetex"),
      1,
      redisKey,
      token,
      "900000",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0][1];
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(request.body))).toMatchObject({
      embeds: [{ title: "USDC reward balance is low" }],
    });
  });

  it("uses a 10-second webhook timeout by default", async () => {
    mockSet.mockResolvedValueOnce("OK");
    mockEval.mockResolvedValueOnce(1);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 204 }));

    await sendDedupedDiscordAlert({
      key: "default-timeout",
      severity: "WARN",
      title: "Default timeout",
      lines: [],
    });

    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  it("caps a configured webhook timeout below the delivery lease", async () => {
    process.env.HEALTH_ALERT_DELIVERY_TIMEOUT_MS = "60000";
    mockSet.mockResolvedValueOnce("OK");
    mockEval.mockResolvedValueOnce(1);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 204 }));

    await sendDedupedDiscordAlert({
      key: "capped-timeout",
      severity: "WARN",
      title: "Capped timeout",
      lines: [],
    });

    expect(timeoutSpy).toHaveBeenCalledWith(29_999);
  });

  it("suppresses delivery when another process owns the delivery lease", async () => {
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

  it("compare-deletes its owned lease when Discord rejects the alert", async () => {
    mockSet.mockResolvedValueOnce("OK");
    mockEval.mockResolvedValueOnce(1);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendDedupedDiscordAlert({
      key: "payout-cap",
      severity: "WARN",
      title: "Daily payout cap is approaching",
      lines: ["80% consumed"],
    });

    const redisKey = "t2p:health-alert:payout-cap";
    const token = mockSet.mock.calls[0][1];
    expect(result).toBe("failed");
    expect(mockEval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("del", KEYS[1])'),
      1,
      redisKey,
      token,
    );
    expect(mockDel).not.toHaveBeenCalled();
  });

  it("does not delete a newer lease after an ownership mismatch", async () => {
    mockSet.mockResolvedValueOnce("OK");
    mockEval.mockResolvedValueOnce(0);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timed out")));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendDedupedDiscordAlert({
      key: "ownership-mismatch",
      severity: "PAGE",
      title: "Ownership changed",
      lines: [],
    });

    expect(result).toBe("failed");
    expect(mockEval).toHaveBeenCalledTimes(1);
    expect(mockDel).not.toHaveBeenCalled();
  });

  it("fails closed for WARN alerts when Redis is unavailable", async () => {
    mockSet.mockRejectedValueOnce(new Error("Redis unavailable"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendDedupedDiscordAlert({
      key: "warn-redis-failure",
      severity: "WARN",
      title: "Warning",
      lines: [],
    });

    expect(result).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds PAGE delivery locally while Redis is unavailable", async () => {
    const key = `page-redis-fallback-${randomUUID()}`;
    mockSet.mockRejectedValue(new Error("Redis unavailable"));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const alert = {
      key,
      severity: "PAGE" as const,
      title: "Page",
      lines: [],
    };

    const first = await sendDedupedDiscordAlert(alert, { cooldownMs: 900_000, nowMs: 100 });
    const second = await sendDedupedDiscordAlert(alert, { cooldownMs: 900_000, nowMs: 101 });

    expect(first).toBe("sent-degraded");
    expect(second).toBe("suppressed-degraded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses an overlapping PAGE fallback while its webhook is in flight", async () => {
    const key = `overlapping-page-redis-fallback-${randomUUID()}`;
    mockSet.mockRejectedValue(new Error("Redis unavailable"));
    let markFetchStarted!: () => void;
    let resolveFetch!: (response: { ok: boolean; status: number }) => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fetchResponse = new Promise<{ ok: boolean; status: number }>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn(() => {
      markFetchStarted();
      return fetchResponse;
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const alert = {
      key,
      severity: "PAGE" as const,
      title: "Overlapping page",
      lines: [],
    };

    const firstDelivery = sendDedupedDiscordAlert(alert, { cooldownMs: 900_000, nowMs: 100 });
    await fetchStarted;
    const secondDelivery = sendDedupedDiscordAlert(alert, { cooldownMs: 900_000, nowMs: 101 });
    resolveFetch({ ok: true, status: 204 });

    await expect(Promise.all([firstDelivery, secondDelivery])).resolves.toEqual([
      "sent-degraded",
      "suppressed-degraded",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("seeds the PAGE fallback cooldown when Redis lease promotion fails", async () => {
    const key = `promotion-failed-page-fallback-${randomUUID()}`;
    mockSet.mockResolvedValueOnce("OK").mockRejectedValueOnce(new Error("Redis unavailable"));
    mockEval.mockRejectedValueOnce(new Error("Redis unavailable"));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const alert = {
      key,
      severity: "PAGE" as const,
      title: "Promotion failure",
      lines: [],
    };

    const first = await sendDedupedDiscordAlert(alert, { cooldownMs: 900_000, nowMs: 100 });
    const second = await sendDedupedDiscordAlert(alert, { cooldownMs: 900_000, nowMs: 101 });

    expect(first).toBe("sent-degraded");
    expect(second).toBe("suppressed-degraded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not suppress a PAGE retry after degraded webhook delivery fails", async () => {
    const key = `failed-page-redis-fallback-${randomUUID()}`;
    mockSet.mockRejectedValue(new Error("Redis unavailable"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const alert = {
      key,
      severity: "PAGE" as const,
      title: "Page retry",
      lines: [],
    };

    const first = await sendDedupedDiscordAlert(alert, { cooldownMs: 900_000, nowMs: 100 });
    const second = await sendDedupedDiscordAlert(alert, { cooldownMs: 900_000, nowMs: 101 });

    expect(first).toBe("failed");
    expect(second).toBe("sent-degraded");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRunHealthMonitor } = vi.hoisted(() => ({
  mockRunHealthMonitor: vi.fn(),
}));

vi.mock("@/lib/health-monitor", () => ({
  runHealthMonitor: mockRunHealthMonitor,
}));

import { POST } from "../route";

const ORIGINAL_ENV = { ...process.env };

function cronRequest(token: string | null = "test-secret") {
  return new NextRequest("http://localhost/api/cron/wallet-health", {
    method: "POST",
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "test-secret";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("/api/cron/wallet-health", () => {
  it("rejects a request without the configured bearer token", async () => {
    const response = await POST(cronRequest("wrong-secret"));

    expect(response.status).toBe(401);
    expect(mockRunHealthMonitor).not.toHaveBeenCalled();
  });

  it("rejects a request that carries no Authorization header", async () => {
    const response = await POST(cronRequest(null));

    expect(response.status).toBe(401);
    expect(mockRunHealthMonitor).not.toHaveBeenCalled();
  });

  it("rejects every request while CRON_SECRET is unset or empty", async () => {
    for (const secret of [undefined, ""]) {
      if (secret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = secret;

      // "undefined" and "" are the tokens a misconfigured scheduler interpolates
      // from an unset variable; neither may satisfy an unset server secret.
      for (const token of [null, "", "undefined"]) {
        expect((await POST(cronRequest(token))).status).toBe(401);
      }
    }

    expect(mockRunHealthMonitor).not.toHaveBeenCalled();
  });

  it("returns the health snapshot and alert delivery outcomes", async () => {
    mockRunHealthMonitor.mockResolvedValueOnce({
      checkedAt: "2026-09-08T00:00:00.000Z",
      wallet: { usdcBalance: "5.0000", availableXlmBalance: "1.0000" },
      metrics: {
        dailyCapPercent: 80,
        reserveStatus: "refill_required",
        sourceStatus: {
          wallet: "healthy",
          payouts: "healthy",
          reserve: "healthy",
          refillTimer: "healthy",
        },
      },
      thresholds: { capPercentThreshold: 80 },
      alerts: [{ key: "wallet-usdc-page" }],
      deliveries: [{ key: "wallet-usdc-page", status: "sent" }],
    });

    const response = await POST(cronRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      metrics: {
        dailyCapPercent: 80,
        reserveStatus: "refill_required",
        sourceStatus: {
          wallet: "healthy",
          payouts: "healthy",
          reserve: "healthy",
          refillTimer: "healthy",
        },
      },
      deliveries: [{ key: "wallet-usdc-page", status: "sent" }],
    });
  });

  it("returns a generic 500 without leaking monitoring configuration", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRunHealthMonitor.mockRejectedValueOnce(new Error("secret SDO_NOT_LEAK"));

    const response = await POST(cronRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Wallet health check failed" });
    expect(JSON.stringify(body)).not.toContain("SDO_NOT_LEAK");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("SDO_NOT_LEAK");
    consoleError.mockRestore();
  });
});

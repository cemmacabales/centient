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

function cronRequest(token = "test-secret") {
  return new NextRequest("http://localhost/api/cron/wallet-health", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
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

  it("returns the health snapshot and alert delivery outcomes", async () => {
    mockRunHealthMonitor.mockResolvedValueOnce({
      checkedAt: "2026-09-08T00:00:00.000Z",
      wallet: { usdcBalance: "5.0000", availableXlmBalance: "1.0000" },
      metrics: { dailyCapPercent: 80, reserveStatus: "refill_required" },
      thresholds: { capPercentThreshold: 80 },
      alerts: [{ key: "wallet-usdc-page" }],
      deliveries: [{ key: "wallet-usdc-page", status: "sent" }],
    });

    const response = await POST(cronRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      metrics: { dailyCapPercent: 80, reserveStatus: "refill_required" },
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

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLoadReserveRefillStatus } = vi.hoisted(() => ({
  mockLoadReserveRefillStatus: vi.fn(),
}));

vi.mock("@/lib/stellar/reserve-refill", () => ({
  loadReserveRefillStatus: mockLoadReserveRefillStatus,
}));

import { POST } from "../route";

const ORIGINAL_ENV = { ...process.env };

function cronRequest(token = "test-secret") {
  return new NextRequest("http://localhost/api/cron/reserve-refill", {
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

describe("/api/cron/reserve-refill", () => {
  it("returns 401 when CRON_SECRET is missing", async () => {
    delete process.env.CRON_SECRET;
    const response = await POST(cronRequest());
    expect(response.status).toBe(401);
    expect(mockLoadReserveRefillStatus).not.toHaveBeenCalled();
  });

  it("returns 401 when the bearer token is missing or wrong", async () => {
    const missing = await POST(
      new NextRequest("http://localhost/api/cron/reserve-refill", {
        method: "POST",
      }),
    );
    const wrong = await POST(cronRequest("wrong-secret"));

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(mockLoadReserveRefillStatus).not.toHaveBeenCalled();
  });

  it("returns 200 when the hot float is healthy", async () => {
    mockLoadReserveRefillStatus.mockResolvedValueOnce({
      status: "healthy",
      hotBalanceUnits: 300_000_000n,
      coldBalanceUnits: 2_000_000_000n,
    });

    const response = await POST(cronRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "healthy",
      hotBalanceUnits: "300000000",
      coldBalanceUnits: "2000000000",
    });
  });

  it("returns 202 with the exact refill request", async () => {
    mockLoadReserveRefillStatus.mockResolvedValueOnce({
      status: "refill_required",
      amountUnits: 750_000_000n,
      hotBalanceUnits: 250_000_000n,
      coldBalanceUnits: 2_000_000_000n,
      coldAfterUnits: 1_250_000_000n,
    });

    const response = await POST(cronRequest());

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "refill_required",
      amountUnits: "750000000",
      hotBalanceUnits: "250000000",
      coldBalanceUnits: "2000000000",
      coldAfterUnits: "1250000000",
    });
  });

  it("returns 503 without proposing a partial refill", async () => {
    mockLoadReserveRefillStatus.mockResolvedValueOnce({
      status: "insufficient_reserve",
      requiredUnits: 750_000_000n,
      availableUnits: 500_000_000n,
      hotBalanceUnits: 250_000_000n,
      coldBalanceUnits: 1_000_000_000n,
    });

    const response = await POST(cronRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "insufficient_reserve",
      requiredUnits: "750000000",
      availableUnits: "500000000",
      hotBalanceUnits: "250000000",
      coldBalanceUnits: "1000000000",
    });
  });

  it("returns a generic 500 without leaking configuration values", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockLoadReserveRefillStatus.mockRejectedValueOnce(
      new Error("bad seed SDO_NOT_LEAK_THIS"),
    );

    const response = await POST(cronRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Reserve refill check failed" });
    expect(JSON.stringify(body)).not.toContain("SDO_NOT_LEAK_THIS");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "SDO_NOT_LEAK_THIS",
    );
    consoleError.mockRestore();
  });
});

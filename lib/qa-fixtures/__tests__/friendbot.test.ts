import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { friendbotFund } from "../friendbot";

// The two failures that are not failures — an already-created account and a
// transient blip — used to abort a fixture run. In the sponsor's case they
// aborted it *before* the sponsorship, which is the expensive half to redo.

const ORIGINAL_FETCH = globalThis.fetch;
const KEY = "GBWWDO5YDAY77SHHYV3FU3T3A7VCKJLXFP4WHXN5RCKPQDUQ5MMONMWR";

function respond(status: number, body = ""): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => body } as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = ORIGINAL_FETCH;
});

/** Run `promise` while letting every pending backoff timer fire. */
async function withTimersFlushed<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  const result = await settled;
  if (!result.ok) throw result.error;
  return result.value;
}

describe("friendbotFund", () => {
  it("returns on a successful funding", async () => {
    const fetchMock = vi.fn(async () => respond(200));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await withTimersFlushed(friendbotFund(KEY));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats an already-created account as success", async () => {
    // Friendbot answers 400 for an account it has already funded. The account
    // exists and holds XLM, which is all the caller needed.
    const fetchMock = vi.fn(async () =>
      respond(400, '{"detail":"op_already_exists createAccountAlreadyExist"}'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const seen: string[] = [];
    await withTimersFlushed(friendbotFund(KEY, { onRetry: (m) => seen.push(m) }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seen.join(" ")).toMatch(/already funded/);
  });

  it("retries a transient failure and succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(503, "upstream unavailable"))
      .mockResolvedValueOnce(respond(200));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await withTimersFlushed(friendbotFund(KEY, { backoffMs: 1 }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a network-level throw rather than giving up on it", async () => {
    // A rejected fetch is as retryable as a 5xx; throwing straight through would
    // defeat the retry the caller asked for.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(respond(200));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await withTimersFlushed(friendbotFund(KEY, { backoffMs: 1 }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the configured attempts, naming the account", async () => {
    const fetchMock = vi.fn(async () => respond(500, "boom"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      withTimersFlushed(friendbotFund(KEY, { attempts: 3, backoffMs: 1 })),
    ).rejects.toThrow(new RegExp(`${KEY} after 3 attempts`));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not treat a non-400 mentioning the marker as already funded", async () => {
    // Only the 400 case means "already exists"; a 500 that happens to echo the
    // string is still a failure.
    const fetchMock = vi.fn(async () => respond(500, "createAccountAlreadyExist"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      withTimersFlushed(friendbotFund(KEY, { attempts: 2, backoffMs: 1 })),
    ).rejects.toThrow(/after 2 attempts/);
  });
});

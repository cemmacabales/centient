import { describe, it, expect, vi } from "vitest";
import { waitForPayoutToSettle } from "@/lib/payout-settle-watch";

// #39: "Total earned" reads totalEarnedUnits, which the worker raises only once
// it has paid. The page refreshes earnings when this resolves true, so a
// contributor's last answer is counted without another submission or a reload.

/** A fetch that answers each call with the next status in turn (the last one repeats). */
function statuses(...answers: Array<string | number | Error>) {
  let call = 0;
  return vi.fn(async (_url: string) => {
    const answer = answers[Math.min(call++, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    if (typeof answer === "number") return new Response("{}", { status: answer });
    return new Response(JSON.stringify({ payoutStatus: answer }), { status: 200 });
  });
}

const noSleep = async () => {};

describe("waitForPayoutToSettle (#39)", () => {
  it("resolves true once the payout is sent, polling the submission's own status", async () => {
    const fetchImpl = statuses("pending", "pending", "sent");
    await expect(waitForPayoutToSettle("sub-1", { fetchImpl, sleep: noSleep })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenCalledWith("/api/submissions/sub-1");
  });

  it("treats confirmed as paid", async () => {
    await expect(waitForPayoutToSettle("s", { fetchImpl: statuses("confirmed"), sleep: noSleep })).resolves.toBe(true);
  });

  it("stops without refreshing when the payout ends unpaid", async () => {
    const fetchImpl = statuses("pending", "failed");
    await expect(waitForPayoutToSettle("s", { fetchImpl, sleep: noSleep })).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops on an error response rather than polling a submission it cannot read", async () => {
    const fetchImpl = statuses(401);
    await expect(waitForPayoutToSettle("s", { fetchImpl, sleep: noSleep })).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rides out a dropped request", async () => {
    const fetchImpl = statuses(new Error("offline"), "sent");
    await expect(waitForPayoutToSettle("s", { fetchImpl, sleep: noSleep })).resolves.toBe(true);
  });

  it("gives up after its attempt budget while the payout is still pending", async () => {
    const fetchImpl = statuses("pending");
    await expect(waitForPayoutToSettle("s", { fetchImpl, sleep: noSleep, maxAttempts: 4 })).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("stops as soon as it is cancelled, e.g. by a logout", async () => {
    let cancelled = false;
    const fetchImpl = vi.fn(async () => {
      cancelled = true;
      return new Response(JSON.stringify({ payoutStatus: "pending" }), { status: 200 });
    });
    await expect(
      waitForPayoutToSettle("s", { fetchImpl, sleep: noSleep, isCancelled: () => cancelled }),
    ).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("waits between polls", async () => {
    const sleep = vi.fn(async () => {});
    await waitForPayoutToSettle("s", { fetchImpl: statuses("pending", "sent"), sleep, intervalMs: 3000 });
    expect(sleep).toHaveBeenCalledWith(3000);
  });
});

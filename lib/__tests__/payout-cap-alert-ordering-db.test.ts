import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// The cap alert's ordering guard (#12, carried forward from #9).
//
// `maybeSendCapAlert()` reports spend by summing the payout ledger — every job
// carrying a `(txHash, amountUnits, broadcastAt)` tuple. It therefore has to run
// *after* the payout that just settled has been written, or it sums a ledger
// missing that payout and reads a crossing it just caused as not-yet-crossed.
//
// These cases control that read/write ordering rather than measuring it. The
// alert is fire-and-forget in production, so nothing here sleeps or polls: the
// delivery mock resolves a promise the test awaits, and the assertions are made
// on what the alert *reported* — a number that could only have come from a read
// of the persisted tuple. A `setTimeout` guard turns "the alert never fired"
// into a named failure instead of a suite-level hang.
//
// Against the parent of the ordering fix, `payReward` raised the alert itself
// before any caller had persisted. These cases run the real `payReward` — only
// the Horizon submit beneath it is replaced — so on that code the alert's read
// returns 0 units spent, `buildPayoutCapAlert` returns null below the threshold,
// and the first case fails on the guard rather than on an assertion.

const { mockSendAlert } = vi.hoisted(() => ({ mockSendAlert: vi.fn() }));

vi.mock("@/lib/health-alert", () => ({ sendDedupedDiscordAlert: mockSendAlert }));

// `payReward` itself is deliberately NOT mocked: it is the function the alert
// used to be raised from, so stubbing it would hide the very ordering under
// test. Only the network edge below it is replaced.
vi.mock("@/lib/stellar/payout-submitter", () => ({ submitMultisigPayout: vi.fn() }));

vi.mock("@/lib/stellar/payout-cosigner", () => ({
  resolvePayoutCoSigner: vi.fn(() => ({ signPayout: vi.fn() })),
}));

vi.mock("@/lib/stellar/balance", () => ({ checkAndAlert: vi.fn(async () => {}) }));

// The real implementation is kept — the positive cases assert on what it
// actually reports. Wrapping it only makes the *call* observable, which is what
// the negative case needs: `maybeSendCapAlert()` is fire-and-forget, so checking
// its delivery after `processJob` returns would race an in-flight alert and pass
// for the wrong reason. The call itself is synchronous at every call site.
vi.mock("@/lib/payout-cap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payout-cap")>();
  return { ...actual, maybeSendCapAlert: vi.fn(actual.maybeSendCapAlert) };
});

vi.mock("@/lib/payout-broadcast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payout-broadcast")>();
  return { ...actual, persistAcceptedPayment: vi.fn(actual.persistAcceptedPayment) };
});

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

import type { HealthAlert } from "@/lib/health-alert";
import { abandonAcceptedPayment, persistAcceptedPayment } from "@/lib/payout-broadcast";
import { maybeSendCapAlert } from "@/lib/payout-cap";
import { processJob } from "@/lib/payout-worker";
import { submitMultisigPayout } from "@/lib/stellar/payout-submitter";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser } from "@/tests/helpers/factories";

const mockSubmitPayout = vi.mocked(submitMultisigPayout);
const mockMaybeSendCapAlert = vi.mocked(maybeSendCapAlert);
const mockPersistAcceptedPayment = vi.mocked(persistAcceptedPayment);

// 1 USDC cap against a 0.9 USDC payout: 90% of the cap, over the 80% default
// threshold, but only once this payout is part of the sum. Nothing else is
// seeded, so a read taken before the tuple lands sees 0% and builds no alert —
// which is exactly the defect these cases pin.
const CAP_UNITS = 10_000_000n;
const PAYOUT_UNITS = 9_000_000n;
const TX_HASH = "cap-alert-ordering-hash";
const ALERT_WAIT_MS = 10_000;

const ORIGINAL_ENV = { ...process.env };

/** What the ledger held at the moment the alert was handed to delivery. */
interface Delivered {
  alert: HealthAlert;
  jobAtAlertTime: { txHash: string | null; broadcastAt: Date | null; amountUnits: bigint | null } | null;
}

/**
 * Resolve when the cap alert reaches delivery, or reject by name if it never
 * does. Awaiting the delivery itself is what makes this ordering-controlled: no
 * case here depends on how long the unawaited alert takes to settle.
 */
function captureCapAlert(jobId: string): Promise<Delivered> {
  return new Promise<Delivered>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("the payout cap alert was never delivered")),
      ALERT_WAIT_MS,
    );
    mockSendAlert.mockImplementation(async (alert: HealthAlert) => {
      if (alert.key !== "payout-cap") return "sent";
      const jobAtAlertTime = await prisma.payoutJob.findUnique({
        where: { id: jobId },
        select: { txHash: true, broadcastAt: true, amountUnits: true },
      });
      clearTimeout(timer);
      resolve({ alert, jobAtAlertTime });
      return "sent";
    });
  });
}

async function enqueueWithdrawal(amountUnits: bigint) {
  const user = await createUser();
  const job = await prisma.payoutJob.create({
    data: {
      type: "WITHDRAWAL",
      status: "processing",
      userId: user.id,
      amountUnits,
      destinationAddress: user.walletAddress,
      workerHeartbeatAt: new Date(),
    },
  });
  return { user, job };
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  process.env.DAILY_PAYOUT_CAP_UNITS = CAP_UNITS.toString();
  delete process.env.HEALTH_CAP_PERCENT_THRESHOLD;
  mockSendAlert.mockResolvedValue("sent");
  mockSubmitPayout.mockResolvedValue({ hash: TX_HASH });
  await truncateAll();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("the daily cap alert is evaluated after the broadcast tuple is persisted", () => {
  it("reports a withdrawal's own units as spend, which only a post-persist read can see", async () => {
    const { job } = await enqueueWithdrawal(PAYOUT_UNITS);
    const delivered = captureCapAlert(job.id);

    await processJob(job.id, null, job.userId!, PAYOUT_UNITS, "WITHDRAWAL");
    const { alert, jobAtAlertTime } = await delivered;

    // The reported spend is the whole proof: 9,000,000 units can only appear in
    // the sum if the tuple written by `persistAcceptedPayment` was already
    // visible to the alert's own ledger read.
    expect(alert.lines).toContain(`${PAYOUT_UNITS} of ${CAP_UNITS} units spent`);
    expect(alert.lines).toContain("90% consumed");
    expect(alert.severity).toBe("WARN");

    // And the tuple itself was durable, not merely in flight.
    expect(jobAtAlertTime).toMatchObject({
      txHash: TX_HASH,
      amountUnits: PAYOUT_UNITS,
    });
    expect(jobAtAlertTime?.broadcastAt).toBeInstanceOf(Date);
    // Raised once, by the persisting caller, with no amount — never also from
    // inside `payReward`, which is where the stale read came from.
    expect(mockMaybeSendCapAlert).toHaveBeenCalledExactlyOnceWith();
  });

  it("does not raise the alert from the broadcast itself, where no tuple exists yet", async () => {
    const { job } = await enqueueWithdrawal(PAYOUT_UNITS);

    // The alert must be a consequence of the persisted ledger, never of the
    // broadcast call. Denying the ledger write proves which one it keys on: the
    // payment settles, the tuple never lands, and no cap alert is due — only the
    // reconciliation page for a payment that cannot be recorded. The real
    // quarantine still runs, so this is the production failure path, not a stub.
    mockPersistAcceptedPayment.mockImplementationOnce(async (payment, _persist, quarantine) => {
      await abandonAcceptedPayment(payment, quarantine);
      return false;
    });

    await processJob(job.id, null, job.userId!, PAYOUT_UNITS, "WITHDRAWAL");

    expect(mockSubmitPayout).toHaveBeenCalledOnce();

    // Deterministic, not a race: every call site invokes `maybeSendCapAlert()`
    // synchronously, so by the time `processJob` has returned the call has
    // either happened or never will. Asserting on the call rather than on its
    // delivery is what makes this assertion sound for a fire-and-forget path.
    expect(mockMaybeSendCapAlert).not.toHaveBeenCalled();

    // And the payment is not silently dropped: it settled, so it pages.
    const keys = mockSendAlert.mock.calls.map(([alert]) => (alert as HealthAlert).key);
    expect(keys).not.toContain("payout-cap");
    expect(keys).toContain("payout-persistence-unavailable");
  });

  it("counts a settled payout once, not twice, when it crosses the threshold", async () => {
    // The rejected alternative fix — passing the amount into the alert — would
    // report 18,000,000 units here, double the cap, because the read already
    // sees the tuple. Spend must equal the ledger exactly.
    const { job } = await enqueueWithdrawal(PAYOUT_UNITS);
    const delivered = captureCapAlert(job.id);

    await processJob(job.id, null, job.userId!, PAYOUT_UNITS, "WITHDRAWAL");
    const { alert } = await delivered;

    const ledger = await prisma.payoutJob.aggregate({
      _sum: { amountUnits: true },
      where: { txHash: { not: null }, broadcastAt: { not: null } },
    });
    expect(ledger._sum.amountUnits).toBe(PAYOUT_UNITS);
    expect(alert.lines).toContain(`${PAYOUT_UNITS} of ${CAP_UNITS} units spent`);
    expect(alert.lines).not.toContain(`blocked attempt: ${PAYOUT_UNITS} units`);
  });
});

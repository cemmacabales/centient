import { beforeEach, describe, expect, it } from "vitest";
import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk";
import {
  runSponsorshipReclaim,
  type ReclaimDeps,
  type ReclaimReport,
  type SponsorshipDisposition,
} from "@/lib/sponsorship-reclaim";
import { sponsorshipLiability } from "@/lib/sponsored-trustline";
import type { ChainSponsorship, RevocationOutcome, SponsoredEntry } from "@/lib/stellar/sponsorship-reclaim";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createTask, createUser, VALID_REASON } from "@/tests/helpers/factories";

// #29 — sponsored-reserve reclaim against the real ledger. Every case runs on the
// database, because the conditional writes (the intent claim, the release, the
// pending reconcile) are the guards under test. The network is faked at
// `ReclaimDeps`; the envelope and chain parsing are covered in
// `lib/stellar/__tests__/sponsorship-reclaim.test.ts`.

const BASE = 5_000_000n; // 0.5 XLM
const NOW = new Date("2026-09-14T12:00:00.000Z");
const SOON = new Date(NOW.getTime() + 120_000);
const PAST = new Date(NOW.getTime() - 1_000);
const SPONSOR = Keypair.random().publicKey();
const G = () => Keypair.random().publicKey();

type Tx = "confirmed" | "failed" | "not_found";
type Next = RevocationOutcome | ((hash: string) => Promise<RevocationOutcome>);

/** Chain state for an address this sponsor sponsors, owner holding 10 XLM spendable unless told otherwise. */
function chainOf(
  entries: SponsoredEntry[],
  extra: Partial<Extract<ChainSponsorship, { exists: true }>> = {},
): ChainSponsorship {
  return {
    exists: true,
    sponsoredEntries: entries,
    straySponsoredLines: 0,
    usdcBalanceUnits: 0n,
    usdcBuyingLiabilitiesUnits: 0n,
    ownerSpendableStroops: 100_000_000n,
    ...extra,
  };
}
const zeroXlm = (entries: SponsoredEntry[]) => chainOf(entries, { ownerSpendableStroops: 0n });
const BOTH: SponsoredEntry[] = ["trustline", "account"];

/** A fake network: chain state and tx status per key, and a queue of submit outcomes per address. */
function fakeNetwork() {
  const chain = new Map<string, ChainSponsorship | Error>();
  const tx = new Map<string, Tx>();
  const outcomes = new Map<string, Next[]>();
  /** What a seeded revocation hash revoked; one this fake prepared revokes what it carried. */
  const revoked = new Map<string, SponsoredEntry[] | Error>();
  const prepared: Array<{ address: string; entries: SponsoredEntry[]; hash: string }> = [];
  const submitted: string[] = [];
  let now = NOW;
  let n = 0;
  let beforeClaim: ((address: string, hash: string) => Promise<void>) | null = null;

  const deps: ReclaimDeps = {
    network: "testnet",
    sponsor: SPONSOR,
    baseReserveStroops: async () => BASE,
    readChain: async (address) => {
      const state = chain.get(address);
      if (state instanceof Error) throw state;
      if (!state) throw new Error(`test: no chain state for ${address}`);
      return state;
    },
    revokedEntries: async (hash) => {
      const seeded = revoked.get(hash);
      if (seeded instanceof Error) throw seeded;
      if (seeded) return seeded;
      const built = prepared.find((p) => p.hash === hash);
      if (!built) throw new Error(`test: no revocation ${hash}`);
      return built.entries;
    },
    txStatus: async (hash) => tx.get(hash) ?? "not_found",
    prepareRevocation: async (address, entries) => {
      const hash = `revoke-${++n}`;
      prepared.push({ address, entries: [...entries], hash });
      if (beforeClaim) await beforeClaim(address, hash);
      return {
        hash,
        expiresAt: new Date(now.getTime() + 180_000),
        entries: [...entries],
        submit: async () => {
          submitted.push(hash);
          const next = outcomes.get(address)?.shift() ?? { outcome: "revoked" };
          return typeof next === "function" ? next(hash) : next;
        },
      };
    },
    now: () => now,
  };

  return {
    deps,
    chain,
    tx,
    outcomes,
    revoked,
    prepared,
    submitted,
    setNow: (date: Date) => {
      now = date;
    },
    onPrepare: (fn: (address: string, hash: string) => Promise<void>) => {
      beforeClaim = fn;
    },
  };
}

let net: ReturnType<typeof fakeNetwork>;

/** A contributor with no linked wallet and nothing owed, unless a case says otherwise. */
const contributor = (overrides: Parameters<typeof createUser>[0] = {}) =>
  createUser({ walletAddress: null, ...overrides });

let createdOffset = 0;
/** Insert a sponsorship row in whatever state a case needs; creation order is insertion order. */
function seedRow(opts: {
  userId: string;
  address?: string;
  kind?: "trustline" | "account+trustline";
  status?: "pending" | "confirmed" | "failed";
  txHash?: string;
  expiresAt?: Date | null;
  reclaimTxHash?: string | null;
  reclaimExpiresAt?: Date | null;
}) {
  return prisma.sponsoredTrustline.create({
    data: {
      userId: opts.userId,
      address: opts.address ?? G(),
      kind: opts.kind ?? "account+trustline",
      status: opts.status ?? "confirmed",
      txHash: opts.txHash ?? `sponsor-${Math.random()}`,
      expiresAt: opts.expiresAt ?? null,
      reclaimTxHash: opts.reclaimTxHash ?? null,
      reclaimExpiresAt: opts.reclaimExpiresAt ?? null,
      createdAt: new Date(NOW.getTime() - 86_400_000 + ++createdOffset),
    },
  });
}

const dryRun = () => runSponsorshipReclaim({ mode: "dry-run", deps: net.deps });
const execute = () => runSponsorshipReclaim({ mode: "execute", deps: net.deps });
const rowOf = (id: string) => prisma.sponsoredTrustline.findUniqueOrThrow({ where: { id } });

/** The one disposition in `report` for sponsorship `id`. */
function dispositionOf(report: ReclaimReport, id: string): SponsorshipDisposition {
  const found = report.sponsorships.find((s) => s.sponsorshipId === id);
  if (!found) throw new Error(`test: sponsorship ${id} not in report`);
  return found;
}

/** An eligible sponsorship: unlinked, nothing owed, both entries sponsored, owner can cover. */
async function eligibleRow() {
  const user = await contributor();
  const row = await seedRow({ userId: user.id });
  net.chain.set(row.address, chainOf(BOTH));
  return row;
}

beforeEach(async () => {
  await truncateAll();
  net = fakeNetwork();
});

describe("dry run", () => {
  it("reports an eligible sponsorship with the reserve it would release, and writes nothing", async () => {
    const row = await eligibleRow();
    const before = await rowOf(row.id);

    const report = await dryRun();

    expect(dispositionOf(report, row.id)).toMatchObject({
      disposition: "eligible",
      entries: BOTH,
      reserveUnits: 3,
      reclaimedStroops: "0",
    });
    expect(report.runId).toBeNull();
    expect(net.prepared).toHaveLength(0);
    expect(await rowOf(row.id)).toEqual(before);
    expect(await prisma.sponsorshipReclaimRun.count()).toBe(0);
  });

  it("does not reconcile or release anything it finds, only reports it", async () => {
    const user = await contributor();
    const landed = await seedRow({ userId: user.id, status: "pending", expiresAt: SOON });
    net.tx.set(landed.txHash, "confirmed");
    const gone = await seedRow({ userId: user.id });
    net.chain.set(gone.address, { exists: false });

    const report = await dryRun();

    expect(dispositionOf(report, landed.id).disposition).toBe("sponsorship_landed");
    expect(dispositionOf(report, gone.id).disposition).toBe("released_by_owner");
    expect((await rowOf(landed.id)).status).toBe("pending");
    expect((await rowOf(gone.id)).revokedAt).toBeNull();
  });
});

describe("rule 1 — a pending sponsorship is reconciled, never revoked", () => {
  it("leaves a pending sponsorship whose envelope could still land", async () => {
    const user = await contributor();
    const row = await seedRow({ userId: user.id, status: "pending", expiresAt: SOON });

    const report = await execute();

    expect(dispositionOf(report, row.id).disposition).toBe("sponsorship_pending");
    expect((await rowOf(row.id)).status).toBe("pending");
    expect(net.prepared).toHaveLength(0);
  });

  it("confirms a pending sponsorship Horizon shows landed, without revoking it in the same run", async () => {
    const user = await contributor();
    const row = await seedRow({ userId: user.id, status: "pending", expiresAt: PAST });
    net.tx.set(row.txHash, "confirmed");
    net.chain.set(row.address, chainOf(BOTH));

    const report = await execute();

    expect(dispositionOf(report, row.id).disposition).toBe("sponsorship_landed");
    expect(await rowOf(row.id)).toMatchObject({ status: "confirmed", revokedAt: null });
    expect(net.prepared).toHaveLength(0);
  });

  it("releases an expired pending sponsorship Horizon never saw — the risk #27 and #28 carried", async () => {
    const user = await contributor();
    const row = await seedRow({ userId: user.id, status: "pending", expiresAt: PAST });
    net.chain.set(row.address, { exists: false });

    const report = await execute();

    expect(dispositionOf(report, row.id)).toMatchObject({ disposition: "sponsorship_never_landed", reserveUnits: 0 });
    expect((await rowOf(row.id)).status).toBe("failed");
    // The address is free again: a fresh outstanding row no longer trips the unique index.
    await expect(seedRow({ userId: user.id, address: row.address })).resolves.toBeTruthy();
  });

  it("releases a pending sponsorship whose envelope Horizon reports failed", async () => {
    const user = await contributor();
    const row = await seedRow({ userId: user.id, status: "pending", expiresAt: SOON });
    net.tx.set(row.txHash, "failed");
    net.chain.set(row.address, { exists: false });

    await execute();

    expect((await rowOf(row.id)).status).toBe("failed");
  });

  it("confirms, rather than releases, an expired pending sponsorship the chain shows sponsored", async () => {
    const user = await contributor();
    const row = await seedRow({ userId: user.id, status: "pending", expiresAt: PAST });
    net.chain.set(row.address, zeroXlm(BOTH));

    const report = await execute();

    expect(dispositionOf(report, row.id).disposition).toBe("sponsorship_landed");
    expect((await rowOf(row.id)).status).toBe("confirmed");
  });
});

describe("rules 3 and 4 — what the chain already shows", () => {
  it("records a merged-away account as released by its owner", async () => {
    const user = await contributor();
    const row = await seedRow({ userId: user.id });
    net.chain.set(row.address, { exists: false });

    const report = await execute();

    expect(dispositionOf(report, row.id)).toMatchObject({ disposition: "released_by_owner", reclaimedStroops: "0" });
    expect(await rowOf(row.id)).toMatchObject({ releasedBy: "owner", reclaimTxHash: null });
    expect((await rowOf(row.id)).revokedAt).not.toBeNull();
    expect(report.totals.ownerReleasedStroops).toBe((3n * BASE).toString());
    expect(net.prepared).toHaveLength(0);
  });

  it("records entries no longer sponsored by this sponsor as released", async () => {
    const user = await contributor();
    const row = await seedRow({ userId: user.id });
    net.chain.set(row.address, chainOf([]));

    const report = await execute();

    expect(dispositionOf(report, row.id).disposition).toBe("released_by_owner");
  });

  it("revokes only the account once the owner has removed the trustline", async () => {
    const user = await contributor();
    const row = await seedRow({ userId: user.id });
    net.chain.set(row.address, chainOf(["account"]));

    const report = await execute();

    expect(net.prepared).toEqual([{ address: row.address, entries: ["account"], hash: "revoke-1" }]);
    expect(dispositionOf(report, row.id)).toMatchObject({
      disposition: "revoked",
      reserveUnits: 2,
      reclaimedStroops: (2n * BASE).toString(),
    });
  });

  it("stops, and sends nothing, when a confirmed revocation of ours is not reflected on the chain", async () => {
    const user = await contributor();
    const row = await seedRow({ userId: user.id, reclaimTxHash: "landed", reclaimExpiresAt: PAST });
    net.tx.set("landed", "confirmed");
    net.chain.set(row.address, chainOf(BOTH));

    const report = await execute();

    expect(dispositionOf(report, row.id)).toMatchObject({ disposition: "unexpected_chain_state", txHash: "landed" });
    expect(net.prepared).toHaveLength(0);
    expect(await rowOf(row.id)).toMatchObject({ revokedAt: null, reclaimTxHash: "landed" });
  });

  it("stops at a sponsored line to another asset, and never records it released", async () => {
    const user = await contributor();
    const row = await seedRow({ userId: user.id });
    net.chain.set(row.address, chainOf([], { straySponsoredLines: 1 }));

    const report = await execute();

    expect(dispositionOf(report, row.id).disposition).toBe("unexpected_chain_state");
    expect((await rowOf(row.id)).revokedAt).toBeNull();
  });
});

describe("rule 5 — active contributors are protected", () => {
  /** Run execute against an otherwise-eligible row and assert it was protected and untouched. */
  async function expectProtected(
    setup: (row: Awaited<ReturnType<typeof seedRow>>, userId: string) => Promise<void>,
    disposition: SponsorshipDisposition["disposition"],
    chain: ChainSponsorship = chainOf(BOTH),
  ) {
    const user = await contributor();
    const row = await seedRow({ userId: user.id });
    net.chain.set(row.address, chain);
    await setup(row, user.id);

    const report = await execute();

    expect(dispositionOf(report, row.id)).toMatchObject({ disposition, reserveUnits: 3 });
    expect(net.prepared).toHaveLength(0);
    expect(await rowOf(row.id)).toMatchObject({ revokedAt: null, reclaimTxHash: null });
  }

  it("protects an address that is any user's linked payout wallet", async () => {
    await expectProtected(async (row) => {
      await createUser({ walletAddress: row.address });
    }, "protected_linked_wallet");
  });

  it("protects the destination of a queued or processing withdrawal", async () => {
    for (const status of ["queued", "processing"] as const) {
      await truncateAll();
      net = fakeNetwork();
      await expectProtected(async (row, userId) => {
        await prisma.payoutJob.create({
          data: { type: "WITHDRAWAL", userId, amountUnits: 1n, destinationAddress: row.address, status },
        });
      }, "protected_payout_in_flight");
    }
  });

  it("protects the wallet of a withdrawal awaiting an admin decision", async () => {
    await expectProtected(async (row, userId) => {
      await prisma.flaggedWithdrawal.create({
        data: { userId, walletAddress: row.address, reason: "SHARED_WALLET", status: "PENDING" },
      });
    }, "protected_payout_in_flight");
  });

  it("protects the wallet of a submission whose payout has not settled, including an unknown status", async () => {
    for (const payoutStatus of ["pending", "sent", "failed", "needs_reconciliation", "some_future_status"]) {
      await truncateAll();
      net = fakeNetwork();
      await expectProtected(async (row, userId) => {
        const task = await createTask();
        await prisma.submission.create({
          data: { walletAddress: row.address, userId, taskId: task.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 1n, payoutStatus },
        });
      }, "protected_unsettled_submission");
    }
  });

  it("protects a sponsorship whose owner still has an unpaid balance", async () => {
    await expectProtected(async (_row, userId) => {
      await prisma.user.update({ where: { id: userId }, data: { pendingBalanceUnits: 1n } });
    }, "protected_owed_balance");
  });

  it("protects an address whose trustline holds USDC or has USDC on order", async () => {
    await expectProtected(async () => {}, "protected_holds_usdc", chainOf(BOTH, { usdcBalanceUnits: 1n }));
    await truncateAll();
    net = fakeNetwork();
    await expectProtected(async () => {}, "protected_holds_usdc", chainOf(BOTH, { usdcBuyingLiabilitiesUnits: 1n }));
  });

  it("does not protect what is finished: settled submissions, a done withdrawal, a resolved flag", async () => {
    const user = await contributor();
    const row = await seedRow({ userId: user.id });
    net.chain.set(row.address, chainOf(BOTH));
    for (const payoutStatus of ["confirmed", "skipped", "abandoned", "accrued"]) {
      const task = await createTask();
      await prisma.submission.create({
        data: { walletAddress: row.address, userId: user.id, taskId: task.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 1n, payoutStatus },
      });
    }
    await prisma.payoutJob.create({
      data: { type: "WITHDRAWAL", userId: user.id, amountUnits: 1n, destinationAddress: row.address, status: "done" },
    });
    await prisma.flaggedWithdrawal.create({
      data: { userId: user.id, walletAddress: row.address, reason: "SHARED_WALLET", status: "REJECTED" },
    });

    const report = await dryRun();

    expect(dispositionOf(report, row.id).disposition).toBe("eligible");
  });
});

describe("rule 6 — the owner must be able to cover the reserve", () => {
  it("skips a zero-XLM owner, since the chain would answer op_low_reserve", async () => {
    const user = await contributor();
    const row = await seedRow({ userId: user.id });
    net.chain.set(row.address, zeroXlm(BOTH));

    const report = await execute();

    expect(dispositionOf(report, row.id).disposition).toBe("owner_cannot_cover_reserve");
    expect(net.prepared).toHaveLength(0);
  });

  it("is eligible at exactly the reserve, and not one stroop below it", async () => {
    const user = await contributor();
    const exact = await seedRow({ userId: user.id });
    net.chain.set(exact.address, chainOf(BOTH, { ownerSpendableStroops: 3n * BASE }));
    const short = await seedRow({ userId: user.id });
    net.chain.set(short.address, chainOf(BOTH, { ownerSpendableStroops: 3n * BASE - 1n }));

    const report = await dryRun();

    expect(dispositionOf(report, exact.id).disposition).toBe("eligible");
    expect(dispositionOf(report, short.id).disposition).toBe("owner_cannot_cover_reserve");
  });
});

describe("rule 7 — execute", () => {
  it("revokes an eligible sponsorship, records how and with what hash, and stores the run", async () => {
    const row = await eligibleRow();
    const before = await sponsorshipLiability();

    const report = await execute();

    expect(dispositionOf(report, row.id)).toMatchObject({
      disposition: "revoked",
      entries: BOTH,
      reserveUnits: 3,
      reclaimedStroops: (3n * BASE).toString(),
      txHash: "revoke-1",
    });
    const after = await rowOf(row.id);
    expect(after).toMatchObject({ releasedBy: "sponsor_revoke", reclaimTxHash: "revoke-1" });
    expect(after.revokedAt).not.toBeNull();
    expect((await sponsorshipLiability()).reserveUnits).toBe(before.reserveUnits - 3);

    const run = await prisma.sponsorshipReclaimRun.findUniqueOrThrow({ where: { id: report.runId! } });
    expect(run).toMatchObject({ network: "testnet", sponsor: SPONSOR, reclaimedStroops: 3n * BASE });
    expect(run.finishedAt).not.toBeNull();
    expect((run.report as unknown as ReclaimReport).sponsorships).toHaveLength(1);
  });

  it("stores no wallet address, even one an error detail names", async () => {
    const lookup = await eligibleRow();
    net.chain.set(lookup.address, new Error(`readChainSponsorship: Horizon account ${lookup.address} has no native balance line`));
    const rejected = await eligibleRow();
    const muxed = new MuxedAccount(new Account(rejected.address, "0"), "7").accountId();
    net.outcomes.set(rejected.address, [{ outcome: "rejected", detail: `op_underfunded for ${rejected.address} via ${muxed}` }]);

    const report = await execute();

    expect(dispositionOf(report, lookup.id).detail).toContain(lookup.address);
    const run = await prisma.sponsorshipReclaimRun.findUniqueOrThrow({ where: { id: report.runId! } });
    const stored = JSON.stringify(run.report);
    for (const address of [lookup.address, rejected.address, muxed]) expect(stored).not.toContain(address);
    const storedOf = (id: string) => (run.report as unknown as ReclaimReport).sponsorships.find((s) => s.sponsorshipId === id);
    expect(storedOf(lookup.id)?.detail).toBe("readChainSponsorship: Horizon account [address] has no native balance line");
    expect(storedOf(rejected.id)?.detail).toBe("op_underfunded for [address] via [address]");
  });

  it("records the revocation's hash on the row before it is broadcast", async () => {
    const row = await eligibleRow();
    net.outcomes.set(row.address, [
      async (hash) => {
        expect((await rowOf(row.id)).reclaimTxHash).toBe(hash);
        return { outcome: "revoked" };
      },
    ]);

    await execute();

    expect(net.submitted).toEqual(["revoke-1"]);
  });

  it("is idempotent: a second run finds nothing outstanding and sends nothing", async () => {
    const row = await eligibleRow();
    await execute();

    const second = await execute();

    expect(second.sponsorships.find((s) => s.sponsorshipId === row.id)).toBeUndefined();
    expect(net.submitted).toEqual(["revoke-1"]);
  });

  it("records an address released between the read and the submit as released by its owner", async () => {
    const row = await eligibleRow();
    net.outcomes.set(row.address, [
      async () => {
        net.chain.set(row.address, { exists: false });
        return { outcome: "not_sponsored", codes: ["op_does_not_exist"] };
      },
    ]);

    const report = await execute();

    expect(dispositionOf(report, row.id).disposition).toBe("released_by_owner");
    expect(await rowOf(row.id)).toMatchObject({ releasedBy: "owner", reclaimTxHash: null, reclaimExpiresAt: null });
  });

  it("releases the intent when the owner could not cover the reserve at submit", async () => {
    const row = await eligibleRow();
    net.outcomes.set(row.address, [{ outcome: "owner_low_reserve" }]);

    const report = await execute();

    expect(dispositionOf(report, row.id).disposition).toBe("owner_cannot_cover_reserve");
    expect(await rowOf(row.id)).toMatchObject({ revokedAt: null, reclaimTxHash: null });
  });

  it("fails a revocation on a stale sequence, then revokes it on the next run", async () => {
    const row = await eligibleRow();
    net.outcomes.set(row.address, [{ outcome: "stale_sequence" }]);

    const first = await execute();
    expect(dispositionOf(first, row.id)).toMatchObject({ disposition: "failed", errorCode: "tx_bad_seq" });
    expect(await rowOf(row.id)).toMatchObject({ revokedAt: null, reclaimTxHash: null });

    const second = await execute();
    expect(dispositionOf(second, row.id)).toMatchObject({ disposition: "revoked", txHash: "revoke-2" });
  });

  it("reads a stale sequence as revoked when the envelope is what consumed it", async () => {
    const row = await eligibleRow();
    net.outcomes.set(row.address, [
      async (hash) => {
        net.tx.set(hash, "confirmed");
        return { outcome: "stale_sequence" };
      },
    ]);

    const report = await execute();

    expect(dispositionOf(report, row.id).disposition).toBe("revoked");
    expect((await rowOf(row.id)).releasedBy).toBe("sponsor_revoke");
  });

  it("releases the intent after a definite rejection", async () => {
    const row = await eligibleRow();
    net.outcomes.set(row.address, [{ outcome: "rejected", detail: "tx_insufficient_fee" }]);

    const report = await execute();

    expect(dispositionOf(report, row.id)).toMatchObject({ disposition: "failed", errorCode: "reclaim_tx_rejected" });
    expect((await rowOf(row.id)).reclaimTxHash).toBeNull();
  });

  it("keeps an unanswered revocation's intent, waits on it, and records it once it lands", async () => {
    const row = await eligibleRow();
    net.outcomes.set(row.address, [{ outcome: "unknown", detail: "timeout" }]);

    const first = await execute();
    expect(dispositionOf(first, row.id)).toMatchObject({ disposition: "reclaim_pending", errorCode: "submission_unknown" });
    expect((await rowOf(row.id)).reclaimTxHash).toBe("revoke-1");

    // Still unseen and not expired: nothing new is built.
    const second = await execute();
    expect(dispositionOf(second, row.id).disposition).toBe("reclaim_pending");
    expect(net.prepared).toHaveLength(1);

    // It landed after all.
    net.tx.set("revoke-1", "confirmed");
    net.chain.set(row.address, chainOf([]));
    const third = await execute();
    expect(dispositionOf(third, row.id)).toMatchObject({
      disposition: "revoked",
      txHash: "revoke-1",
      reclaimedStroops: (3n * BASE).toString(),
    });
    expect(await rowOf(row.id)).toMatchObject({ releasedBy: "sponsor_revoke", reclaimTxHash: "revoke-1" });
    expect(net.prepared).toHaveLength(1);
  });

  it("credits only the entries an earlier revocation carried once it is seen to land (PR #105 review)", async () => {
    const user = await contributor();
    const row = await seedRow({ userId: user.id, kind: "account+trustline" });
    // The owner had already removed the trustline, so the revocation carried the account alone.
    net.chain.set(row.address, chainOf(["account"]));
    net.outcomes.set(row.address, [{ outcome: "unknown", detail: "timeout" }]);
    await execute();
    expect(net.prepared).toEqual([{ address: row.address, entries: ["account"], hash: "revoke-1" }]);

    net.tx.set("revoke-1", "confirmed");
    net.chain.set(row.address, chainOf([]));
    const report = await execute();

    expect(dispositionOf(report, row.id)).toMatchObject({
      disposition: "revoked",
      txHash: "revoke-1",
      reserveUnits: 2,
      reclaimedStroops: (2n * BASE).toString(),
    });
    expect(report.totals.reclaimedStroops).toBe((2n * BASE).toString());
    const stored = await prisma.sponsorshipReclaimRun.findUniqueOrThrow({ where: { id: report.runId! } });
    expect(stored.reclaimedStroops).toBe(2n * BASE);
  });

  it("releases nothing, and retries next run, when a landed revocation's operations cannot be read", async () => {
    const user = await contributor();
    const row = await seedRow({ userId: user.id, reclaimTxHash: "landed", reclaimExpiresAt: PAST });
    net.tx.set("landed", "confirmed");
    net.chain.set(row.address, chainOf([]));
    net.revoked.set("landed", new Error("horizon down"));

    const report = await execute();

    expect(dispositionOf(report, row.id)).toMatchObject({ disposition: "failed", reclaimedStroops: "0" });
    expect(await rowOf(row.id)).toMatchObject({ revokedAt: null, reclaimTxHash: "landed" });
  });

  it("drops an unanswered revocation that expired unseen, and revokes afresh", async () => {
    const row = await eligibleRow();
    net.outcomes.set(row.address, [{ outcome: "unknown", detail: "timeout" }]);
    await execute();

    net.setNow(new Date(NOW.getTime() + 600_000));
    const report = await execute();

    expect(dispositionOf(report, row.id)).toMatchObject({ disposition: "revoked", txHash: "revoke-2" });
  });

  it("does not broadcast when another run claimed the row between prepare and claim", async () => {
    const row = await eligibleRow();
    net.onPrepare(async () => {
      await prisma.sponsoredTrustline.update({
        where: { id: row.id },
        data: { reclaimTxHash: "other-run", reclaimExpiresAt: SOON },
      });
    });

    const report = await execute();

    expect(dispositionOf(report, row.id).disposition).toBe("reclaim_pending");
    expect(net.submitted).toHaveLength(0);
    expect((await rowOf(row.id)).reclaimTxHash).toBe("other-run");
  });

  it("records a failed lookup for one row and carries on with the rest", async () => {
    const first = await eligibleRow();
    const broken = await eligibleRow();
    net.chain.set(broken.address, new Error("Horizon 503"));
    const last = await eligibleRow();

    const report = await execute();

    expect(dispositionOf(report, first.id).disposition).toBe("revoked");
    expect(dispositionOf(report, broken.id)).toMatchObject({ disposition: "failed", errorCode: "lookup_failed", detail: "Horizon 503" });
    expect(dispositionOf(report, last.id).disposition).toBe("revoked");
    expect((await rowOf(broken.id)).revokedAt).toBeNull();
    expect(report.totals.reclaimedStroops).toBe((6n * BASE).toString());
  });

  it("writes no intent when the revocation cannot be built", async () => {
    const row = await eligibleRow();
    net.deps.prepareRevocation = async () => {
      throw new Error("sponsorship reclaim: envelope does not carry a valid sponsor signature for this network");
    };

    const report = await execute();

    expect(dispositionOf(report, row.id).disposition).toBe("failed");
    expect((await rowOf(row.id)).reclaimTxHash).toBeNull();
  });

  it("refuses a row with an unknown kind without stopping the run", async () => {
    const user = await contributor();
    const odd = await prisma.sponsoredTrustline.create({
      data: { userId: user.id, address: G(), kind: "claimable_balance", txHash: "x", createdAt: new Date(NOW.getTime() - 90_000_000) },
    });
    const row = await eligibleRow();

    const report = await execute();

    expect(dispositionOf(report, odd.id)).toMatchObject({ disposition: "failed", errorCode: "unknown_kind" });
    expect(dispositionOf(report, row.id).disposition).toBe("revoked");
  });
});

describe("the run report", () => {
  it("totals dispositions and what is still locked, and carries no user data", async () => {
    const user = await contributor({ email: "someone@example.com" });
    const skipped = await seedRow({ userId: user.id });
    net.chain.set(skipped.address, zeroXlm(BOTH));
    const trustlineOnly = await seedRow({ userId: user.id, kind: "trustline" });
    net.chain.set(trustlineOnly.address, zeroXlm(["trustline"]));
    const released = await seedRow({ userId: user.id });
    net.chain.set(released.address, { exists: false });
    const revoked = await eligibleRow();

    const report = await execute();

    expect(report.totals).toEqual({
      sponsorships: 4,
      byDisposition: { owner_cannot_cover_reserve: 2, released_by_owner: 1, revoked: 1 },
      reclaimedStroops: (3n * BASE).toString(),
      ownerReleasedStroops: (3n * BASE).toString(),
      lockedReserveUnits: 4,
    });
    expect(dispositionOf(report, revoked.id).disposition).toBe("revoked");

    const stored = JSON.stringify((await prisma.sponsorshipReclaimRun.findFirstOrThrow()).report);
    expect(stored).not.toContain(user.id);
    expect(stored).not.toContain("someone@example.com");
    expect(stored).not.toMatch(/userId/);
    // Stored entries are keyed by sponsorship id, with no wallet address; the
    // returned report still names each address for the operator.
    expect(stored).not.toMatch(/"address"/);
    for (const entry of report.sponsorships) {
      expect(entry.address).toMatch(/^G[A-Z2-7]{55}$/);
      expect(stored).not.toContain(entry.address);
      expect(stored).toContain(entry.sponsorshipId);
    }
  });

  it("stores nothing when the base reserve cannot be read", async () => {
    await eligibleRow();
    net.deps.baseReserveStroops = async () => {
      throw new Error("Horizon down");
    };

    await expect(execute()).rejects.toThrow("Horizon down");
    expect(await prisma.sponsorshipReclaimRun.count()).toBe(0);
  });
});

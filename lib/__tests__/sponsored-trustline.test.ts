import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  countOutstandingSponsorships,
  addressSponsoredByOther,
  checkSponsorAllowed,
  confirmSponsorship,
  failSponsorship,
  hasConfirmedSponsorship,
  livePendingSponsorship,
  openSponsorshipIntent,
  sponsorMaxOutstanding,
  sponsorshipLiability,
} from "@/lib/sponsored-trustline";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser } from "@/tests/helpers/factories";

// #330 — the per-user outstanding-sponsorship cap + cross-user address lock,
// backed by the sponsored_trustlines table.
// #27 — the intent written before broadcast, and the partial unique index that
// allows one outstanding sponsorship per address. Every case runs against the
// real database, because the index is the guard under test.

/** A fresh, never-funded `G…` address. */
const G = () => Keypair.random().publicKey();
const NOW = new Date("2026-09-15T01:00:00.000Z");
const LATER = new Date(NOW.getTime() + 180_000);

type Kind = "trustline" | "account+trustline";

/** Insert a ledger row directly, in whatever state a case needs. */
function seedRow(opts: {
  userId: string;
  address?: string;
  kind?: Kind;
  status?: "pending" | "confirmed" | "failed";
  txHash?: string;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}) {
  const status = opts.status ?? "confirmed";
  return prisma.sponsoredTrustline.create({
    data: {
      userId: opts.userId,
      address: opts.address ?? G(),
      kind: opts.kind ?? "trustline",
      status,
      txHash: opts.txHash ?? `h-${Math.random()}`,
      // As the request path writes it: a confirmed row records when it landed.
      confirmedAt: status === "confirmed" ? NOW : null,
      expiresAt: opts.expiresAt ?? null,
      revokedAt: opts.revokedAt ?? null,
    },
  });
}

const neverSeen = vi.fn(async () => "not_found" as const);
/** The chain still shows the address trusting USDC through our sponsored trustline. */
const trusts = vi.fn(async () => ({ usdcTrustline: true, sponsoredEntries: ["trustline" as const] }));

beforeEach(async () => {
  await truncateAll();
  delete process.env.SPONSOR_MAX_OUTSTANDING;
  neverSeen.mockClear();
  trusts.mockClear();
});
afterEach(() => {
  delete process.env.SPONSOR_MAX_OUTSTANDING;
});

describe("sponsorMaxOutstanding", () => {
  it("defaults to 2", () => {
    expect(sponsorMaxOutstanding()).toBe(2);
  });
  it("honors a valid SPONSOR_MAX_OUTSTANDING override", () => {
    process.env.SPONSOR_MAX_OUTSTANDING = "1";
    expect(sponsorMaxOutstanding()).toBe(1);
  });
  it("falls back to 2 on a non-positive / non-numeric override", () => {
    process.env.SPONSOR_MAX_OUTSTANDING = "0";
    expect(sponsorMaxOutstanding()).toBe(2);
    process.env.SPONSOR_MAX_OUTSTANDING = "garbage";
    expect(sponsorMaxOutstanding()).toBe(2);
  });
});

describe("countOutstandingSponsorships", () => {
  it("counts this user's pending and confirmed rows, not revoked or failed ones", async () => {
    const a = await createUser();
    const b = await createUser();
    await seedRow({ userId: a.id, status: "confirmed" });
    await seedRow({ userId: a.id, status: "pending", expiresAt: LATER });
    await seedRow({ userId: a.id, status: "failed" });
    await seedRow({ userId: a.id, status: "confirmed", revokedAt: new Date() });
    await seedRow({ userId: b.id, status: "confirmed" });

    expect(await countOutstandingSponsorships(a.id)).toBe(2);
    expect(await countOutstandingSponsorships(b.id)).toBe(1);
  });
});

describe("addressSponsoredByOther", () => {
  it("is true when another user holds an outstanding sponsorship for the address", async () => {
    const a = await createUser();
    const b = await createUser();
    const addr = G();
    await seedRow({ userId: a.id, address: addr });
    expect(await addressSponsoredByOther(addr, b.id)).toBe(true);
  });
  it("is true while another user's sponsorship is still pending", async () => {
    const a = await createUser();
    const b = await createUser();
    const addr = G();
    await seedRow({ userId: a.id, address: addr, status: "pending", expiresAt: LATER });
    expect(await addressSponsoredByOther(addr, b.id)).toBe(true);
  });
  it("is false for the same user (their own outstanding sponsorship)", async () => {
    const a = await createUser();
    const addr = G();
    await seedRow({ userId: a.id, address: addr });
    expect(await addressSponsoredByOther(addr, a.id)).toBe(false);
  });
  it("is false once the other user's sponsorship is revoked", async () => {
    const a = await createUser();
    const b = await createUser();
    const addr = G();
    await seedRow({ userId: a.id, address: addr, revokedAt: new Date() });
    expect(await addressSponsoredByOther(addr, b.id)).toBe(false);
  });
  it("is false when the other user's attempt failed", async () => {
    const a = await createUser();
    const b = await createUser();
    const addr = G();
    await seedRow({ userId: a.id, address: addr, status: "failed" });
    expect(await addressSponsoredByOther(addr, b.id)).toBe(false);
  });
});

describe("checkSponsorAllowed", () => {
  it("allows under the cap", async () => {
    const a = await createUser();
    await seedRow({ userId: a.id });
    expect(await checkSponsorAllowed(a.id, G())).toEqual({ ok: true });
  });
  it("rejects with cap_reached once at the cap", async () => {
    const a = await createUser();
    await seedRow({ userId: a.id });
    await seedRow({ userId: a.id });
    expect(await checkSponsorAllowed(a.id, G())).toEqual({ ok: false, reason: "cap_reached" });
  });
  it("counts a pending sponsorship against the cap — its reserve may already be locked", async () => {
    process.env.SPONSOR_MAX_OUTSTANDING = "1";
    const a = await createUser();
    await seedRow({ userId: a.id, status: "pending", expiresAt: LATER });
    expect(await checkSponsorAllowed(a.id, G())).toEqual({ ok: false, reason: "cap_reached" });
  });
  it("does not count a failed attempt against the cap", async () => {
    process.env.SPONSOR_MAX_OUTSTANDING = "1";
    const a = await createUser();
    await seedRow({ userId: a.id, status: "failed" });
    expect(await checkSponsorAllowed(a.id, G())).toEqual({ ok: true });
  });
  it("does not let the user's own pending row for this address block its retry", async () => {
    process.env.SPONSOR_MAX_OUTSTANDING = "1";
    const a = await createUser();
    const addr = G();
    await seedRow({ userId: a.id, address: addr, status: "pending", expiresAt: LATER });
    expect(await checkSponsorAllowed(a.id, addr)).toEqual({ ok: true });
  });
  it("allows again after one sponsorship is revoked (frees a slot)", async () => {
    const a = await createUser();
    const one = await seedRow({ userId: a.id });
    await seedRow({ userId: a.id });
    await prisma.sponsoredTrustline.update({ where: { id: one.id }, data: { revokedAt: new Date() } });
    expect(await checkSponsorAllowed(a.id, G())).toEqual({ ok: true });
  });
  it("rejects with address_sponsored_by_other before checking the cap", async () => {
    const a = await createUser();
    const b = await createUser();
    const addr = G();
    await seedRow({ userId: a.id, address: addr });
    // b is under their own cap but the address is locked to a.
    expect(await checkSponsorAllowed(b.id, addr)).toEqual({
      ok: false,
      reason: "address_sponsored_by_other",
    });
  });
  it("respects a lowered SPONSOR_MAX_OUTSTANDING=1", async () => {
    process.env.SPONSOR_MAX_OUTSTANDING = "1";
    const a = await createUser();
    await seedRow({ userId: a.id });
    expect(await checkSponsorAllowed(a.id, G())).toEqual({ ok: false, reason: "cap_reached" });
  });
});

describe("hasConfirmedSponsorship", () => {
  it("is true only for this user's confirmed, unreleased sponsorship of the address", async () => {
    const a = await createUser();
    const b = await createUser();
    const confirmed = await seedRow({ userId: a.id });
    const pending = await seedRow({ userId: a.id, status: "pending", expiresAt: LATER });
    const released = await seedRow({ userId: a.id, revokedAt: NOW });

    expect(await hasConfirmedSponsorship(a.id, confirmed.address)).toBe(true);
    expect(await hasConfirmedSponsorship(b.id, confirmed.address)).toBe(false);
    expect(await hasConfirmedSponsorship(a.id, pending.address)).toBe(false);
    expect(await hasConfirmedSponsorship(a.id, released.address)).toBe(false);
  });
});

describe("livePendingSponsorship", () => {
  it("is true only for a pending row whose envelope has not expired", async () => {
    const a = await createUser();
    const live = G();
    const expired = G();
    const confirmed = G();
    await seedRow({ userId: a.id, address: live, status: "pending", expiresAt: LATER });
    await seedRow({ userId: a.id, address: expired, status: "pending", expiresAt: new Date(NOW.getTime() - 1) });
    await seedRow({ userId: a.id, address: confirmed, status: "confirmed" });

    expect(await livePendingSponsorship(live, NOW)).toBe(true);
    expect(await livePendingSponsorship(expired, NOW)).toBe(false);
    expect(await livePendingSponsorship(confirmed, NOW)).toBe(false);
    expect(await livePendingSponsorship(G(), NOW)).toBe(false);
  });
});

describe("the outstanding-address unique index", () => {
  it("refuses a second outstanding row for one address, even for another user", async () => {
    const a = await createUser();
    const b = await createUser();
    const addr = G();
    await seedRow({ userId: a.id, address: addr, status: "pending", expiresAt: LATER });
    await expect(seedRow({ userId: b.id, address: addr })).rejects.toMatchObject({ code: "P2002" });
  });
  it("allows a new row beside failed and revoked ones", async () => {
    const a = await createUser();
    const addr = G();
    await seedRow({ userId: a.id, address: addr, status: "failed" });
    await seedRow({ userId: a.id, address: addr, status: "confirmed", revokedAt: new Date() });
    await expect(seedRow({ userId: a.id, address: addr, status: "pending", expiresAt: LATER })).resolves.toBeTruthy();
  });
});

describe("openSponsorshipIntent", () => {
  /** An intent for `txHash`, expiring at LATER. */
  const intent = (userId: string, address: string, txHash: string, kind: Kind = "account+trustline") => ({
    userId,
    address,
    kind,
    txHash,
    expiresAt: LATER,
  });

  it("writes a pending row carrying the hash and expiry, and says to submit", async () => {
    const a = await createUser();
    const addr = G();
    const decision = await openSponsorshipIntent(intent(a.id, addr, "H1"), { txStatus: neverSeen, chain: trusts, now: NOW });

    expect(decision.action).toBe("submit");
    const rows = await prisma.sponsoredTrustline.findMany({ where: { address: addr } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: a.id,
      txHash: "H1",
      kind: "account+trustline",
      status: "pending",
      confirmedAt: null,
    });
    expect(rows[0].expiresAt?.toISOString()).toBe(LATER.toISOString());
    expect(decision).toEqual({ action: "submit", id: rows[0].id });
  });

  it("re-submits the identical envelope against the same row — Horizon applies one hash at most once", async () => {
    const a = await createUser();
    const addr = G();
    const first = await openSponsorshipIntent(intent(a.id, addr, "H1"), { txStatus: neverSeen, chain: trusts, now: NOW });
    const again = await openSponsorshipIntent(intent(a.id, addr, "H1"), { txStatus: neverSeen, chain: trusts, now: NOW });

    expect(again).toEqual(first);
    expect(await prisma.sponsoredTrustline.count({ where: { address: addr } })).toBe(1);
  });

  it("answers already_confirmed for an address this user's sponsorship already confirmed", async () => {
    const a = await createUser();
    const addr = G();
    await seedRow({ userId: a.id, address: addr, status: "confirmed", txHash: "H1" });
    expect(
      await openSponsorshipIntent(intent(a.id, addr, "H2"), { txStatus: neverSeen, chain: trusts, now: NOW }),
    ).toEqual({ action: "already_confirmed" });
    expect(trusts).toHaveBeenCalledWith(addr);
    expect(await prisma.sponsoredTrustline.count({ where: { address: addr } })).toBe(1);
  });

  it("answers address_in_use when another user holds the address", async () => {
    const a = await createUser();
    const b = await createUser();
    const addr = G();
    await seedRow({ userId: a.id, address: addr, status: "pending", txHash: "H1", expiresAt: LATER });
    expect(
      await openSponsorshipIntent(intent(b.id, addr, "H2"), { txStatus: neverSeen, chain: trusts, now: NOW }),
    ).toEqual({ action: "address_in_use" });
  });

  it("refuses a second envelope while the first could still land", async () => {
    const a = await createUser();
    const addr = G();
    await seedRow({ userId: a.id, address: addr, status: "pending", txHash: "H1", expiresAt: LATER });

    const decision = await openSponsorshipIntent(intent(a.id, addr, "H2"), { txStatus: neverSeen, chain: trusts, now: NOW });

    expect(decision).toEqual({ action: "prior_pending" });
    expect(neverSeen).toHaveBeenCalledWith("H1");
    const rows = await prisma.sponsoredTrustline.findMany({ where: { address: addr } });
    expect(rows.map((r) => [r.txHash, r.status])).toEqual([["H1", "pending"]]);
  });

  it("confirms the prior envelope instead of submitting a second when Horizon shows it landed", async () => {
    const a = await createUser();
    const addr = G();
    await seedRow({ userId: a.id, address: addr, status: "pending", txHash: "H1", expiresAt: LATER });
    const landed = vi.fn(async () => "confirmed" as const);

    expect(
      await openSponsorshipIntent(intent(a.id, addr, "H2"), { txStatus: landed, chain: trusts, now: NOW }),
    ).toEqual({ action: "already_confirmed" });
    const rows = await prisma.sponsoredTrustline.findMany({ where: { address: addr } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ txHash: "H1", status: "confirmed" });
    expect(rows[0].confirmedAt).not.toBeNull();
  });

  it("replaces a prior envelope Horizon reports as failed", async () => {
    const a = await createUser();
    const addr = G();
    await seedRow({ userId: a.id, address: addr, status: "pending", txHash: "H1", expiresAt: LATER });
    const failed = vi.fn(async () => "failed" as const);

    const decision = await openSponsorshipIntent(intent(a.id, addr, "H2"), { txStatus: failed, chain: trusts, now: NOW });

    expect(decision.action).toBe("submit");
    const rows = await prisma.sponsoredTrustline.findMany({ where: { address: addr }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.txHash, r.status])).toEqual([
      ["H1", "failed"],
      ["H2", "pending"],
    ]);
  });

  it("replaces a prior envelope that was never seen and has expired", async () => {
    const a = await createUser();
    const addr = G();
    await seedRow({
      userId: a.id,
      address: addr,
      status: "pending",
      txHash: "H1",
      expiresAt: new Date(NOW.getTime() - 60_000),
    });

    const decision = await openSponsorshipIntent(intent(a.id, addr, "H2"), { txStatus: neverSeen, chain: trusts, now: NOW });

    expect(decision.action).toBe("submit");
    expect(await countOutstandingSponsorships(a.id)).toBe(1);
    const outstanding = await prisma.sponsoredTrustline.findFirst({
      where: { address: addr, status: { not: "failed" } },
    });
    expect(outstanding?.txHash).toBe("H2");
  });

  it("does not write anything when the Horizon lookup for the prior envelope fails", async () => {
    const a = await createUser();
    const addr = G();
    await seedRow({ userId: a.id, address: addr, status: "pending", txHash: "H1", expiresAt: LATER });
    const down = vi.fn(async () => {
      throw new Error("horizon down");
    });

    await expect(
      openSponsorshipIntent(intent(a.id, addr, "H2"), { txStatus: down, chain: trusts, now: NOW }),
    ).rejects.toThrow("horizon down");
    const rows = await prisma.sponsoredTrustline.findMany({ where: { address: addr } });
    expect(rows.map((r) => [r.txHash, r.status])).toEqual([["H1", "pending"]]);
  });

  it("a rebuild after tx_bad_seq leaves exactly one outstanding row", async () => {
    const a = await createUser();
    const addr = G();
    const first = await openSponsorshipIntent(intent(a.id, addr, "H1"), { txStatus: neverSeen, chain: trusts, now: NOW });
    if (first.action !== "submit") throw new Error("expected submit");
    await failSponsorship(first.id, "H1");

    const second = await openSponsorshipIntent(intent(a.id, addr, "H2"), { txStatus: neverSeen, chain: trusts, now: NOW });
    if (second.action !== "submit") throw new Error("expected submit");
    await confirmSponsorship(second.id, "H2");

    expect(await countOutstandingSponsorships(a.id)).toBe(1);
    const rows = await prisma.sponsoredTrustline.findMany({ where: { address: addr }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.txHash, r.status])).toEqual([
      ["H1", "failed"],
      ["H2", "confirmed"],
    ]);
  });
});

describe("openSponsorshipIntent — a confirmed row the chain no longer backs (PR #105 review)", () => {
  const intent = (userId: string, address: string, txHash: string, kind: Kind) => ({
    userId,
    address,
    kind,
    txHash,
    expiresAt: LATER,
  });
  /** The chain shows no USDC trustline, and these entries still sponsored. */
  const gone = (...sponsoredEntries: Array<"trustline" | "account">) =>
    vi.fn(async () => ({ usdcTrustline: false, sponsoredEntries }));
  const rowsFor = (address: string) =>
    prisma.sponsoredTrustline.findMany({ where: { address }, orderBy: { createdAt: "asc" } });

  it("releases a trustline sponsorship whose trustline the owner removed, and submits on a fresh row", async () => {
    const a = await createUser();
    const addr = G();
    const old = await seedRow({ userId: a.id, address: addr, kind: "trustline", txHash: "H1" });

    const decision = await openSponsorshipIntent(intent(a.id, addr, "H2", "trustline"), {
      txStatus: neverSeen,
      chain: gone(),
      now: NOW,
    });

    expect(decision.action).toBe("submit");
    const [released, fresh] = await rowsFor(addr);
    expect(released).toMatchObject({ id: old.id, releasedBy: "owner", status: "confirmed" });
    expect(released.revokedAt).not.toBeNull();
    expect(fresh).toMatchObject({ txHash: "H2", status: "pending", kind: "trustline" });
    expect(decision).toEqual({ action: "submit", id: fresh.id });
    expect(await countOutstandingSponsorships(a.id)).toBe(1);
  });

  it("releases a merged-away account's sponsorship, and submits a new account+trustline on a fresh row", async () => {
    const a = await createUser();
    const addr = G();
    await seedRow({ userId: a.id, address: addr, kind: "account+trustline", txHash: "H1" });

    const decision = await openSponsorshipIntent(intent(a.id, addr, "H2", "account+trustline"), {
      txStatus: neverSeen,
      chain: gone(),
      now: NOW,
    });

    expect(decision.action).toBe("submit");
    expect((await rowsFor(addr)).map((r) => [r.txHash, r.status, r.releasedBy])).toEqual([
      ["H1", "confirmed", "owner"],
      ["H2", "pending", null],
    ]);
  });

  it("reopens the row, rather than releasing it, while the account it created is still sponsored", async () => {
    const a = await createUser();
    const addr = G();
    const old = await seedRow({ userId: a.id, address: addr, kind: "account+trustline", txHash: "H1" });

    const decision = await openSponsorshipIntent(intent(a.id, addr, "H2", "trustline"), {
      txStatus: neverSeen,
      chain: gone("account"),
      now: NOW,
    });

    expect(decision).toEqual({ action: "submit", id: old.id });
    const rows = await rowsFor(addr);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ txHash: "H2", status: "pending", kind: "account+trustline", revokedAt: null });
    expect(rows[0].confirmedAt).not.toBeNull();
    // The account's reserve is still locked, so the liability still counts it.
    expect((await sponsorshipLiability()).reserveUnits).toBe(3);
  });

  it("returns a reopened row to confirmed when its new envelope fails, and settles it when it lands", async () => {
    const a = await createUser();
    const addr = G();
    const old = await seedRow({ userId: a.id, address: addr, kind: "account+trustline", txHash: "H1" });
    const reopen = (txHash: string) =>
      openSponsorshipIntent(intent(a.id, addr, txHash, "trustline"), { txStatus: neverSeen, chain: gone("account"), now: NOW });

    await reopen("H2");
    await failSponsorship(old.id, "H2");
    expect(await prisma.sponsoredTrustline.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
      status: "confirmed",
      txHash: "H2",
    });

    await reopen("H3");
    await confirmSponsorship(old.id, "H3");
    expect(await prisma.sponsoredTrustline.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
      status: "confirmed",
      txHash: "H3",
    });
    expect(await countOutstandingSponsorships(a.id)).toBe(1);
  });

  it("writes nothing when the chain lookup fails", async () => {
    const a = await createUser();
    const addr = G();
    await seedRow({ userId: a.id, address: addr, kind: "trustline", txHash: "H1" });
    const down = vi.fn(async () => {
      throw new Error("horizon down");
    });

    await expect(
      openSponsorshipIntent(intent(a.id, addr, "H2", "trustline"), { txStatus: neverSeen, chain: down, now: NOW }),
    ).rejects.toThrow("horizon down");
    expect((await rowsFor(addr)).map((r) => [r.txHash, r.status, r.revokedAt])).toEqual([["H1", "confirmed", null]]);
  });

  it("never reads the chain for, or resets, another user's confirmed row", async () => {
    const a = await createUser();
    const b = await createUser();
    const addr = G();
    await seedRow({ userId: a.id, address: addr, kind: "trustline", txHash: "H1" });
    const chain = gone();

    expect(
      await openSponsorshipIntent(intent(b.id, addr, "H2", "trustline"), { txStatus: neverSeen, chain, now: NOW }),
    ).toEqual({ action: "address_in_use" });
    expect(chain).not.toHaveBeenCalled();
  });

  it("lets racing resets of one confirmed row produce a single outstanding row", async () => {
    const a = await createUser();
    const addr = G();
    await seedRow({ userId: a.id, address: addr, kind: "trustline", txHash: "H1" });

    const decisions = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        openSponsorshipIntent(intent(a.id, addr, `R${i}`, "trustline"), { txStatus: neverSeen, chain: gone(), now: NOW }),
      ),
    );

    expect(decisions.filter((d) => d.action === "submit")).toHaveLength(1);
    expect(await countOutstandingSponsorships(a.id)).toBe(1);
  });
});

describe("openSponsorshipIntent under concurrency", () => {
  const CALLERS = 8;

  it("lets exactly one of many users claim an address", async () => {
    const users = await Promise.all(Array.from({ length: CALLERS }, () => createUser()));
    const addr = G();

    const decisions = await Promise.all(
      users.map((u, i) =>
        openSponsorshipIntent(
          { userId: u.id, address: addr, kind: "account+trustline", txHash: `H${i}`, expiresAt: LATER },
          { txStatus: neverSeen, chain: trusts, now: NOW },
        ),
      ),
    );

    expect(decisions.filter((d) => d.action === "submit")).toHaveLength(1);
    expect(decisions.filter((d) => d.action === "address_in_use")).toHaveLength(CALLERS - 1);
    expect(await prisma.sponsoredTrustline.count({ where: { address: addr } })).toBe(1);
  });

  it("lets one user's racing builds for one address produce a single outstanding row", async () => {
    const a = await createUser();
    const addr = G();

    const decisions = await Promise.all(
      Array.from({ length: CALLERS }, (_, i) =>
        openSponsorshipIntent(
          { userId: a.id, address: addr, kind: "account+trustline", txHash: `H${i}`, expiresAt: LATER },
          { txStatus: neverSeen, chain: trusts, now: NOW },
        ),
      ),
    );

    expect(decisions.filter((d) => d.action === "submit")).toHaveLength(1);
    expect(decisions.filter((d) => d.action === "prior_pending")).toHaveLength(CALLERS - 1);
    expect(await prisma.sponsoredTrustline.count({ where: { address: addr } })).toBe(1);
  });

  it("points duplicate submits of one envelope at one row", async () => {
    const a = await createUser();
    const addr = G();

    const decisions = await Promise.all(
      Array.from({ length: CALLERS }, () =>
        openSponsorshipIntent(
          { userId: a.id, address: addr, kind: "account+trustline", txHash: "SAME", expiresAt: LATER },
          { txStatus: neverSeen, chain: trusts, now: NOW },
        ),
      ),
    );

    const ids = new Set(decisions.map((d) => (d.action === "submit" ? d.id : d.action)));
    expect(ids.size).toBe(1);
    expect(await prisma.sponsoredTrustline.count({ where: { address: addr } })).toBe(1);
  });
});

describe("confirmSponsorship / failSponsorship", () => {
  it("only settle the row while it still carries the hash that was submitted", async () => {
    const a = await createUser();
    const row = await seedRow({ userId: a.id, status: "pending", txHash: "H2", expiresAt: LATER });

    await failSponsorship(row.id, "H1");
    await confirmSponsorship(row.id, "H1");

    expect(await prisma.sponsoredTrustline.findUnique({ where: { id: row.id } })).toMatchObject({
      status: "pending",
      confirmedAt: null,
    });
  });

  it("never downgrade a confirmed sponsorship to failed", async () => {
    const a = await createUser();
    const row = await seedRow({ userId: a.id, status: "pending", txHash: "H1", expiresAt: LATER });

    await confirmSponsorship(row.id, "H1");
    await failSponsorship(row.id, "H1");

    const settled = await prisma.sponsoredTrustline.findUnique({ where: { id: row.id } });
    expect(settled?.status).toBe("confirmed");
    expect(settled?.confirmedAt).not.toBeNull();
  });
});

describe("sponsorshipLiability", () => {
  it("totals outstanding reserve units by kind and status, ignoring failed and revoked rows", async () => {
    const a = await createUser();
    const b = await createUser();
    await seedRow({ userId: a.id, kind: "account+trustline", status: "confirmed" });
    await seedRow({ userId: a.id, kind: "trustline", status: "confirmed" });
    await seedRow({ userId: b.id, kind: "account+trustline", status: "pending", expiresAt: LATER });
    await seedRow({ userId: b.id, kind: "account+trustline", status: "failed" });
    await seedRow({ userId: b.id, kind: "trustline", status: "confirmed", revokedAt: new Date() });

    expect(await sponsorshipLiability()).toEqual({
      outstanding: 3,
      pending: 1,
      // account+trustline locks 3 base reserves (2 for the account, 1 for the line).
      reserveUnits: 3 + 1 + 3,
      byKind: {
        trustline: { confirmed: 1, pending: 0 },
        "account+trustline": { confirmed: 1, pending: 1 },
      },
    });
  });

  it("refuses to report when an outstanding row has a kind with no known reserve cost", async () => {
    const a = await createUser();
    await seedRow({ userId: a.id, kind: "account+trustline" });
    await prisma.sponsoredTrustline.create({
      data: { userId: a.id, address: G(), kind: "legacy-kind", txHash: "h-legacy", status: "confirmed" },
    });

    await expect(sponsorshipLiability()).rejects.toThrow('unknown sponsored trustline kind "legacy-kind"');
  });

  it("is all zeros on an empty ledger", async () => {
    expect(await sponsorshipLiability()).toEqual({
      outstanding: 0,
      pending: 0,
      reserveUnits: 0,
      byKind: {
        trustline: { confirmed: 0, pending: 0 },
        "account+trustline": { confirmed: 0, pending: 0 },
      },
    });
  });
});

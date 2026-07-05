import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  countOutstandingSponsorships,
  addressSponsoredByOther,
  checkSponsorAllowed,
  recordSponsorship,
  sponsorMaxOutstanding,
} from "@/lib/sponsored-trustline";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser } from "@/tests/helpers/factories";

// #330 — the per-user outstanding-sponsorship cap + cross-user address lock,
// backed by the sponsored_trustlines table.

const G = () => Keypair.random().publicKey();

beforeEach(async () => {
  await truncateAll();
  delete process.env.SPONSOR_MAX_OUTSTANDING;
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
  it("counts only this user's non-revoked rows", async () => {
    const a = await createUser();
    const b = await createUser();
    await recordSponsorship({ userId: a.id, address: G(), kind: "trustline", txHash: "h1" });
    await recordSponsorship({ userId: a.id, address: G(), kind: "trustline", txHash: "h2" });
    await recordSponsorship({ userId: b.id, address: G(), kind: "trustline", txHash: "h3" });
    // One of A's is revoked → no longer outstanding.
    const first = await prisma.sponsoredTrustline.findFirst({ where: { userId: a.id } });
    await prisma.sponsoredTrustline.update({ where: { id: first!.id }, data: { revokedAt: new Date() } });

    expect(await countOutstandingSponsorships(a.id)).toBe(1);
    expect(await countOutstandingSponsorships(b.id)).toBe(1);
  });
});

describe("addressSponsoredByOther", () => {
  it("is true when another user holds an outstanding sponsorship for the address", async () => {
    const a = await createUser();
    const b = await createUser();
    const addr = G();
    await recordSponsorship({ userId: a.id, address: addr, kind: "trustline", txHash: "h" });
    expect(await addressSponsoredByOther(addr, b.id)).toBe(true);
  });
  it("is false for the same user (their own outstanding sponsorship)", async () => {
    const a = await createUser();
    const addr = G();
    await recordSponsorship({ userId: a.id, address: addr, kind: "trustline", txHash: "h" });
    expect(await addressSponsoredByOther(addr, a.id)).toBe(false);
  });
  it("is false once the other user's sponsorship is revoked", async () => {
    const a = await createUser();
    const b = await createUser();
    const addr = G();
    await recordSponsorship({ userId: a.id, address: addr, kind: "trustline", txHash: "h" });
    await prisma.sponsoredTrustline.updateMany({ where: { address: addr }, data: { revokedAt: new Date() } });
    expect(await addressSponsoredByOther(addr, b.id)).toBe(false);
  });
});

describe("checkSponsorAllowed", () => {
  it("allows under the cap", async () => {
    const a = await createUser();
    await recordSponsorship({ userId: a.id, address: G(), kind: "trustline", txHash: "h" });
    expect(await checkSponsorAllowed(a.id, G())).toEqual({ ok: true });
  });
  it("rejects with cap_reached once at the cap", async () => {
    const a = await createUser();
    await recordSponsorship({ userId: a.id, address: G(), kind: "trustline", txHash: "h1" });
    await recordSponsorship({ userId: a.id, address: G(), kind: "trustline", txHash: "h2" });
    expect(await checkSponsorAllowed(a.id, G())).toEqual({ ok: false, reason: "cap_reached" });
  });
  it("allows again after one sponsorship is revoked (frees a slot)", async () => {
    const a = await createUser();
    await recordSponsorship({ userId: a.id, address: G(), kind: "trustline", txHash: "h1" });
    await recordSponsorship({ userId: a.id, address: G(), kind: "trustline", txHash: "h2" });
    const one = await prisma.sponsoredTrustline.findFirst({ where: { userId: a.id } });
    await prisma.sponsoredTrustline.update({ where: { id: one!.id }, data: { revokedAt: new Date() } });
    expect(await checkSponsorAllowed(a.id, G())).toEqual({ ok: true });
  });
  it("rejects with address_sponsored_by_other before checking the cap", async () => {
    const a = await createUser();
    const b = await createUser();
    const addr = G();
    await recordSponsorship({ userId: a.id, address: addr, kind: "trustline", txHash: "h" });
    // b is under their own cap but the address is locked to a.
    expect(await checkSponsorAllowed(b.id, addr)).toEqual({
      ok: false,
      reason: "address_sponsored_by_other",
    });
  });
  it("respects a lowered SPONSOR_MAX_OUTSTANDING=1", async () => {
    process.env.SPONSOR_MAX_OUTSTANDING = "1";
    const a = await createUser();
    await recordSponsorship({ userId: a.id, address: G(), kind: "trustline", txHash: "h" });
    expect(await checkSponsorAllowed(a.id, G())).toEqual({ ok: false, reason: "cap_reached" });
  });
});

describe("recordSponsorship", () => {
  it("is idempotent for the same outstanding (userId, address)", async () => {
    const a = await createUser();
    const addr = G();
    await recordSponsorship({ userId: a.id, address: addr, kind: "trustline", txHash: "h1" });
    await recordSponsorship({ userId: a.id, address: addr, kind: "trustline", txHash: "h2" });
    expect(await prisma.sponsoredTrustline.count({ where: { userId: a.id, address: addr } })).toBe(1);
  });
});

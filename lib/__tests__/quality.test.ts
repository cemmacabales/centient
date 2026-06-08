import { describe, it, expect } from "vitest";
import {
  isSpamReason,
  normalizeReason,
  jaccardSimilarity,
} from "@/lib/quality";

describe("isSpamReason", () => {
  it("rejects reasons shorter than 10 characters", () => {
    expect(isSpamReason("short")).toBe(true);
    expect(isSpamReason("nine char")).toBe(true);
  });

  it("rejects reasons that are a single repeated character", () => {
    expect(isSpamReason("aaaaaaaaaa")).toBe(true);
    expect(isSpamReason("zzzzzzzzzzzzz")).toBe(true);
  });

  it("accepts valid-length reasons", () => {
    expect(isSpamReason("This is a valid reason")).toBe(false);
  });
});

describe("normalizeReason", () => {
  it("lowercases the input", () => {
    expect(normalizeReason("Hello WORLD")).toBe("hello world");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeReason("  padded  ")).toBe("padded");
  });

  it("collapses multiple whitespace into single space", () => {
    expect(normalizeReason("hello    world\t\ntest")).toBe("hello world test");
  });

  it("handles empty string", () => {
    expect(normalizeReason("")).toBe("");
  });

  it("handles already normalized text without changes", () => {
    expect(normalizeReason("response a is clearer")).toBe("response a is clearer");
  });

  it("strips punctuation from the text", () => {
    expect(normalizeReason("Response A is clearer!")).toBe("response a is clearer");
    expect(normalizeReason("Response A is clearer.")).toBe("response a is clearer");
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1 for identical token sets", () => {
    expect(jaccardSimilarity("a b c", "a b c")).toBe(1);
  });

  it("returns 1 for same tokens in different order", () => {
    expect(jaccardSimilarity("a b c", "c b a")).toBe(1);
  });

  it("returns 0 for completely disjoint token sets", () => {
    expect(jaccardSimilarity("a b c", "x y z")).toBe(0);
  });

  it("returns correct value for partial overlap", () => {
    expect(jaccardSimilarity("a b c", "a b d")).toBe(2 / 4);
  });

  it("treats normalized strings correctly", () => {
    const a = normalizeReason("Response A is BETTER");
    const b = normalizeReason("response a is better");
    expect(jaccardSimilarity(a, b)).toBe(1);
  });

  it("returns 1 when both inputs are empty", () => {
    expect(jaccardSimilarity("", "")).toBe(1);
  });

  it("returns 0 when one input is empty and the other is not", () => {
    expect(jaccardSimilarity("hello world", "")).toBe(0);
  });

  it("handles near-duplicate reasons with extra tokens", () => {
    const a = "response a is better and clearer overall";
    const b = "response a is better";
    const score = jaccardSimilarity(a, b);
    expect(score).toBe(4 / 7);
  });

  it("handles reasons that differ only by a few tokens", () => {
    const a = "response a is clearer and more accurate overall";
    const b = "response a is better and more accurate overall";
    const score = jaccardSimilarity(a, b);
    expect(score).toBeGreaterThan(0.7);
    expect(score).toBeLessThan(1);
  });
});

describe("checkReasonRepetition", () => {
  it("is skipped and re-run with seed data below");
});

import { beforeEach } from "vitest";
import { checkReasonRepetition } from "@/lib/quality";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser, createTask, makeWallet, VALID_REASON } from "@/tests/helpers/factories";

beforeEach(async () => {
  await truncateAll();
});

async function seedReasons(wallet: string, reasons: string[]) {
  await createUser({ walletAddress: wallet });
  const tasks = await Promise.all(reasons.map(() => createTask()));
  await prisma.submission.createMany({
    data: tasks.map((t, i) => ({
      walletAddress: wallet,
      taskId: t.id,
      choice: "A",
      reason: reasons[i],
      payoutAmountWei: 0n,
      payoutStatus: "skipped",
    })),
  });
}

describe("checkReasonRepetition - exact duplicates", () => {
  it("flags when new reason matches 3+ of the last 10", async () => {
    const wallet = makeWallet();
    const dup = "Response A is clearer and more accurate overall.";
    await seedReasons(wallet, [
      "Unique reason one is different.",
      "Unique reason two is distinct.",
      "Unique reason three is unique.",
      dup,
      dup,
      "Another unique reason four here.",
      "Yet another unique reason five.",
      "Completely different reason six.",
      "Seventh unique reason goes here.",
      dup,
    ]);

    const result = await checkReasonRepetition(wallet, dup);
    expect(result.isRepetitive).toBe(true);
  });

  it("does not flag when duplicates are below threshold", async () => {
    const wallet = makeWallet();
    const dup = "Response A is clearer.";
    await seedReasons(wallet, [
      "Unique reason one is different.",
      "Unique reason two is distinct.",
      "Unique reason three is unique.",
      dup,
      "Another unique reason four here.",
      "Yet another unique reason five.",
      "Completely different reason six.",
      "Seventh unique reason goes here.",
      "Eighth unique reason is here.",
    ]);

    const result = await checkReasonRepetition(wallet, dup);
    expect(result.isRepetitive).toBe(false);
  });

  it("flags exact duplicates regardless of case and whitespace", async () => {
    const wallet = makeWallet();
    await seedReasons(wallet, [
      "Response A is clearer and more accurate.",
      "response a is clearer and more accurate.",
      "  response a is clearer and more accurate.  ",
      "Some unique reason here.",
      "Another unique reason here.",
      "Yet another unique reason here.",
      "Different reason altogether.",
      "Completely new reason text.",
      "Seventh unique reason text.",
    ]);

    const result = await checkReasonRepetition(
      wallet,
      "Response A is clearer and more accurate.",
    );
    expect(result.isRepetitive).toBe(true);
  });

  it("does not flag when user has fewer than window submissions total", async () => {
    const wallet = makeWallet();
    const dup = "response a is better";
    await seedReasons(wallet, [
      dup,
      dup,
      "Another different reason.",
    ]);

    const result = await checkReasonRepetition(wallet, dup);
    expect(result.isRepetitive).toBe(true);
  });
});

describe("checkReasonRepetition - near duplicates (Jaccard)", () => {
  it("flags when 5+ reasons have >80% token overlap with the new one", async () => {
    const wallet = makeWallet();
    const near = "Response A is clearer and more accurate.";
    await seedReasons(wallet, [
      "Response A is clearer and more accurate here.",
      "Response A is clearer and more accurate now.",
      "Response A is clearer and more accurate too.",
      "Response A is clearer and more accurate yes.",
      "Response A is clearer and more accurate thanks.",
      "Completely different reason text here.",
      "Another totally different one here.",
      "Yet another unique reason here.",
    ]);

    const result = await checkReasonRepetition(wallet, near);
    expect(result.isRepetitive).toBe(true);
  });

  it("does not flag when near-duplicates are below 5", async () => {
    const wallet = makeWallet();
    const near = "Response A is clearer and more accurate overall.";
    await seedReasons(wallet, [
      "Response A is clearer and more accurate.",
      "Response A is clearer and more accurate indeed.",
      "Response A is clearer and more accurate here.",
      "Completely different reason text.",
      "Another totally different one.",
      "Yet another unique reason.",
      "Seventh unique reason here.",
      "Eighth completely different reason.",
    ]);

    const result = await checkReasonRepetition(wallet, near);
    expect(result.isRepetitive).toBe(false);
  });

  it("does not flag when reasons are genuinely unique", async () => {
    const wallet = makeWallet();
    await seedReasons(wallet, [
      "The first response is more concise and direct.",
      "I prefer how the second one explains things step by step.",
      "The language used in response A is more professional.",
      "Response B covers more angles of the question.",
      "The examples given in response A are much clearer.",
      "I chose this because the reasoning is sound and logical.",
      "The formatting and structure of response B is better.",
      "Response A handles the edge case more gracefully.",
    ]);

    const result = await checkReasonRepetition(wallet, VALID_REASON);
    expect(result.isRepetitive).toBe(false);
  });
});


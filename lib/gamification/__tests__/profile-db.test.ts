// #203 — display names against a real database: opt-in, unique whatever the
// case, filtered, and an admin hide that retires the name for good.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../server-analytics", () => ({ captureStanding: vi.fn(), captureServer: vi.fn() }));

import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser } from "@/tests/helpers/factories";
import { captureServer } from "../server-analytics";
import { hideDisplayName, setBoardProfile } from "../profile";

let userId: string;

beforeEach(async () => {
  await truncateAll();
  vi.mocked(captureServer).mockReset();
  userId = (await createUser()).id;
});

const settings = (id = userId) =>
  prisma.user.findUniqueOrThrow({
    where: { id },
    select: { displayName: true, showOnBoard: true, displayNameHiddenAt: true },
  });

describe("setBoardProfile", () => {
  it("is opt-in: a new labeler has no name and isn't shown", async () => {
    expect(await settings()).toEqual({ displayName: null, showOnBoard: false, displayNameHiddenAt: null });
  });

  it("sets a name, lowercase, and shows it once asked to", async () => {
    expect(await setBoardProfile(userId, { displayName: "Tala.Labels", showOnBoard: true })).toEqual({
      ok: true,
      settings: { displayName: "tala.labels", showOnBoard: true, nameHidden: false },
    });
    expect(vi.mocked(captureServer).mock.calls).toEqual([[userId, "display_name_set", { shown: true }]]);
  });

  it("turns showing off and on without touching the name", async () => {
    await setBoardProfile(userId, { displayName: "tala.labels", showOnBoard: true });
    vi.mocked(captureServer).mockReset();
    expect(await setBoardProfile(userId, { showOnBoard: false })).toMatchObject({
      ok: true,
      settings: { displayName: "tala.labels", showOnBoard: false },
    });
    expect(captureServer).not.toHaveBeenCalled();
  });

  it("needs a name before it can show one", async () => {
    expect(await setBoardProfile(userId, { showOnBoard: true })).toEqual({ ok: false, error: "name_required" });
    expect((await settings()).showOnBoard).toBe(false);
  });

  it("keeps names unique whatever the case", async () => {
    const other = (await createUser()).id;
    await setBoardProfile(other, { displayName: "tala.labels" });
    expect(await setBoardProfile(userId, { displayName: "TALA.labels" })).toEqual({ ok: false, error: "name_taken" });
    expect((await settings()).displayName).toBeNull();
  });

  it("lets a labeler keep their own name when they save it again", async () => {
    await setBoardProfile(userId, { displayName: "tala.labels" });
    expect(await setBoardProfile(userId, { displayName: "Tala.Labels", showOnBoard: true })).toMatchObject({ ok: true });
  });

  it("filters names, and says why", async () => {
    expect(await setBoardProfile(userId, { displayName: "admin" })).toEqual({ ok: false, error: "not_allowed" });
    expect(await setBoardProfile(userId, { displayName: "ab" })).toEqual({ ok: false, error: "too_short" });
    expect((await settings()).displayName).toBeNull();
  });

  it("refuses a showOnBoard that isn't true or false", async () => {
    expect(await setBoardProfile(userId, { showOnBoard: "yes" })).toEqual({ ok: false, error: "invalid" });
  });
});

describe("hideDisplayName", () => {
  beforeEach(async () => {
    await setBoardProfile(userId, { displayName: "rude.name", showOnBoard: true });
  });

  it("clears the name, stops showing it and asks for another", async () => {
    expect(await hideDisplayName(userId)).toEqual({ name: "rude.name" });
    const s = await settings();
    expect(s).toMatchObject({ displayName: null, showOnBoard: false });
    expect(s.displayNameHiddenAt).toBeInstanceOf(Date);
  });

  it("retires the name: nobody can choose it again", async () => {
    await hideDisplayName(userId);
    expect(await setBoardProfile(userId, { displayName: "rude.name" })).toEqual({ ok: false, error: "name_retired" });
    const other = (await createUser()).id;
    expect(await setBoardProfile(other, { displayName: "Rude.Name" })).toEqual({ ok: false, error: "name_retired" });
  });

  it("clears the prompt once the labeler chooses a new name", async () => {
    await hideDisplayName(userId);
    expect(await setBoardProfile(userId, { displayName: "kind.name", showOnBoard: true })).toEqual({
      ok: true,
      settings: { displayName: "kind.name", showOnBoard: true, nameHidden: false },
    });
    expect((await settings()).displayNameHiddenAt).toBeNull();
  });

  it("does nothing for a labeler with no name", async () => {
    const other = (await createUser()).id;
    expect(await hideDisplayName(other)).toBeNull();
    expect((await settings(other)).displayNameHiddenAt).toBeNull();
  });
});

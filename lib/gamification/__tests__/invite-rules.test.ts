import { describe, it, expect } from "vitest";
import { INVITE_RULES, inviteLink, newInviteCode, normalizeInviteCode } from "../invite-rules";

describe("invite codes", () => {
  it("are 8 characters with no look-alikes (no 0, O, 1, I, L)", () => {
    for (let i = 0; i < 200; i++) {
      const code = newInviteCode();
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    }
  });

  it("match case-insensitively and refuse anything else", () => {
    expect(normalizeInviteCode(" abcd2345 ")).toBe("ABCD2345");
    for (const raw of ["", "ABC", "ABCD23450", "ABCD 234", "ABCD-234", "ABCD0234", null, 7]) {
      expect(normalizeInviteCode(raw)).toBeNull();
    }
  });

  it("links to the site with ?invite=", () => {
    expect(inviteLink("ABCD2345", "https://centient.work")).toBe("https://centient.work/?invite=ABCD2345");
  });

  it("pay 50 XP each, capped at 10 rewarded invites per inviter", () => {
    expect(INVITE_RULES).toMatchObject({ xp: 50, cap: 10 });
  });
});

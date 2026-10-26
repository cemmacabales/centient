// @vitest-environment jsdom
// #203 — an invite link's code moves from the address bar into the cookie the
// wallet sign-in route reads, and the param leaves the address bar either way.
import { beforeEach, describe, expect, it } from "vitest";
import { captureInviteFromUrl } from "../invite-link";

const clearCookie = () => {
  document.cookie = "centient_invite=; Max-Age=0; Path=/";
};

beforeEach(() => {
  clearCookie();
  window.history.replaceState(null, "", "/");
});

describe("captureInviteFromUrl", () => {
  it("keeps a good code in the invite cookie and strips only its param", () => {
    window.history.replaceState(null, "", "/?invite=abcd2345&utm_source=qr#top");
    captureInviteFromUrl();
    expect(document.cookie).toContain("centient_invite=ABCD2345");
    expect(window.location.search).toBe("?utm_source=qr");
    expect(window.location.hash).toBe("#top");
  });

  it("drops a bad code without setting the cookie", () => {
    window.history.replaceState(null, "", "/?invite=NOT-A-CODE");
    captureInviteFromUrl();
    expect(document.cookie).not.toContain("centient_invite");
    expect(window.location.search).toBe("");
  });

  it("leaves a page without an invite alone", () => {
    window.history.replaceState(null, "", "/?code=BQF2026");
    captureInviteFromUrl();
    expect(document.cookie).not.toContain("centient_invite");
    expect(window.location.search).toBe("?code=BQF2026");
  });
});

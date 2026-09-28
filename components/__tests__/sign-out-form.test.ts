// @vitest-environment jsdom
// Sign-out on the claim and payout-setup screens. The pairing the relay SDK
// stores outlives the session cookie, so sign-out has to drop it — but never
// wait long for a relay, or fail because of one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const disconnect = vi.fn();
vi.mock("@/lib/stellar/wallet", () => ({ disconnect: () => disconnect(), SIGN_OUT_WAIT_MS: 4_000 }));

import SignOutForm from "@/components/SignOutForm";
import { SIGN_OUT_WAIT_MS } from "@/lib/stellar/wallet";

afterEach(() => {
  cleanup();
  disconnect.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Render the form and record when it actually posts. */
function renderForm(): { posted: () => boolean } {
  let posted = false;
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {
    posted = true;
  });
  render(createElement(SignOutForm, { className: "" }));
  return { posted: () => posted };
}

describe("SignOutForm", () => {
  it("drops the wallet session, then posts the logout", async () => {
    let dropped = false;
    disconnect.mockImplementation(async () => {
      dropped = true;
    });
    const form = renderForm();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    });

    expect(dropped).toBe(true);
    expect(form.posted()).toBe(true);
  });

  it("still signs out when dropping the session fails", async () => {
    disconnect.mockRejectedValue(new Error("relay gone"));
    const form = renderForm();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    });

    expect(form.posted()).toBe(true);
  });

  it("lets the wallet finish its own bounded cleanup before posting", async () => {
    // A stuck relay holds the wallet's session cleanup for about 2 s. Posting
    // first unloads the page and leaves the stale session in storage.
    vi.useFakeTimers();
    let dropped = false;
    disconnect.mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            dropped = true;
            resolve();
          }, 2_500),
        ),
    );
    const form = renderForm();

    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(form.posted()).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(dropped).toBe(true);
    expect(form.posted()).toBe(true);
  });

  it("does not wait on a relay that never answers", async () => {
    vi.useFakeTimers();
    disconnect.mockImplementation(() => new Promise(() => {}));
    const form = renderForm();

    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SIGN_OUT_WAIT_MS);
    });

    expect(form.posted()).toBe(true);
  });
});

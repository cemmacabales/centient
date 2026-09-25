// @vitest-environment jsdom
// Sign-out on the claim and payout-setup screens. The pairing the relay SDK
// stores outlives the session cookie, so sign-out has to drop it — but never
// wait long for a relay, or fail because of one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const disconnect = vi.fn();
vi.mock("@/lib/stellar/wallet", () => ({ disconnect: () => disconnect() }));

import SignOutForm from "@/components/SignOutForm";

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

  it("does not wait on a relay that never answers", async () => {
    vi.useFakeTimers();
    disconnect.mockImplementation(() => new Promise(() => {}));
    const form = renderForm();

    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(form.posted()).toBe(true);
  });
});

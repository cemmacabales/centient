// @vitest-environment jsdom
// The ranking pair's keyboard wiring (#35), driven through real key events.
// ranking-task-card.test.ts covers each state's markup and the pure key model;
// this covers what static markup cannot — that a keydown on a radio reaches
// choiceForKey, checks the next response and moves focus to it.
import { afterEach, describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import TaskCard, { TaskCardView } from "@/components/TaskCard";

const task = {
  id: "task-1",
  prompt: "Which answer explains photosynthesis better?",
  responseA: "Plants turn light into chemical energy.",
  responseB: "Plants eat sunlight.",
};

afterEach(cleanup);

/** Mounts a stateful TaskCard and returns its two radios by accessible name. */
function renderCard() {
  render(createElement(TaskCard, { task, onSubmit: async () => {}, loading: false }));
  return {
    a: screen.getByRole("radio", { name: "Response A" }),
    b: screen.getByRole("radio", { name: "Response B" }),
  };
}

describe("TaskCard — keyboard operation", () => {
  it.each(["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"])(
    "%s on Response A checks Response B and moves focus to it",
    (key) => {
      const { a, b } = renderCard();
      a.focus();
      fireEvent.keyDown(a, { key });
      expect(b.getAttribute("aria-checked")).toBe("true");
      expect(a.getAttribute("aria-checked")).toBe("false");
      expect(document.activeElement).toBe(b);
      expect(b.tabIndex).toBe(0);
      expect(a.tabIndex).toBe(-1);
    },
  );

  it("arrows wrap from Response B back to Response A", () => {
    const { a, b } = renderCard();
    fireEvent.click(b);
    b.focus();
    fireEvent.keyDown(b, { key: "ArrowDown" });
    expect(a.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(a);
  });

  it.each([" ", "Enter"])("%j checks the focused response and keeps the page from scrolling", (key) => {
    const { a } = renderCard();
    a.focus();
    const notPrevented = fireEvent.keyDown(a, { key });
    expect(notPrevented).toBe(false);
    expect(a.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(a);
  });

  it("leaves Tab to the browser, so focus can leave the group", () => {
    const { a, b } = renderCard();
    a.focus();
    expect(fireEvent.keyDown(a, { key: "Tab" })).toBe(true);
    expect(a.getAttribute("aria-checked")).toBe("false");
    expect(b.getAttribute("aria-checked")).toBe("false");
  });

  it("opens the reason field once a response is chosen from the keyboard", () => {
    const { a } = renderCard();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.keyDown(a, { key: "Enter" });
    expect(screen.getByRole("textbox", { name: /Why\?/ })).toBeTruthy();
  });
});

describe("TaskCardView — keyboard reports through onChoose", () => {
  it("calls onChoose with the other response on an arrow key", () => {
    const onChoose = vi.fn();
    render(
      createElement(TaskCardView, {
        task,
        choice: "A",
        reason: "",
        loading: false,
        error: null,
        onChoose,
        onReasonChange: () => {},
        onSubmit: () => {},
      }),
    );
    fireEvent.keyDown(screen.getByRole("radio", { name: "Response A" }), { key: "ArrowRight" });
    expect(onChoose).toHaveBeenCalledExactlyOnceWith("B");
  });
});

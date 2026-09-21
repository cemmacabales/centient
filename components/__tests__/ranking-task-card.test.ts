// The ranking surface (#35). No React Testing Library / jsdom here, so each state
// of TaskCardView renders to static markup with react-dom/server, as
// wallet-sign-in does; the keyboard model is a pure function, tested directly.
// Assertions are on roles, states, names and document order — not on Tailwind
// classes, which prove nothing about keyboard or screen-reader access.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskCardView, choiceForKey } from "@/components/TaskCard";

const task = {
  id: "task-1",
  prompt: "Which answer explains photosynthesis better?",
  responseA: "Plants turn light into chemical energy.",
  responseB: "Plants eat sunlight.",
};

const noop = () => {};

type Props = Parameters<typeof TaskCardView>[0];

/** Renders one TaskCardView state (nothing chosen, by default) to static HTML. */
function render(overrides: Partial<Props> = {}): string {
  const props: Props = {
    task,
    choice: null,
    reason: "",
    loading: false,
    error: null,
    onChoose: noop,
    onReasonChange: noop,
    onSubmit: noop,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(TaskCardView, props));
}

/** The opening tag of the element carrying `attr`. */
function tagWith(html: string, attr: string): string {
  const at = html.indexOf(attr);
  expect(at, `no element with ${attr}`).toBeGreaterThanOrEqual(0);
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
}

/** The value of `name` on the element carrying `attr`. */
function attrOf(html: string, attr: string, name: string): string | undefined {
  return tagWith(html, attr).match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

/** The text inside the element with this id (no nested markup expected). */
function textOf(html: string, id: string): string | undefined {
  return html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`))?.[1];
}

const reasonOk = "Response A names the actual energy conversion.";

describe("TaskCardView — the pair is one exclusive choice", () => {
  it("exposes the two responses as a labelled radiogroup", () => {
    const html = render();
    expect(attrOf(html, 'role="radiogroup"', "aria-label")).toBe("Which response is better?");
    expect(html.match(/role="radio"/g)).toHaveLength(2);
  });

  it.each(["A", "B"] as const)("names choice %s after its response and describes it with the response text", (side) => {
    const html = render();
    const radio = `id="choice-${side}"`;
    expect(attrOf(html, radio, "role")).toBe("radio");
    expect(textOf(html, attrOf(html, radio, "aria-labelledby")!)).toBe(`Response ${side}`);
    expect(textOf(html, attrOf(html, radio, "aria-describedby")!)).toBe(
      side === "A" ? task.responseA : task.responseB,
    );
  });

  it("does not nest a second interactive control inside a choice", () => {
    // Before a choice there is no submit bar, so any button would be in the pair.
    const html = render();
    expect(html).not.toContain("<button");
    expect(html).not.toContain("aria-pressed");
  });

  it("starts with nothing checked and only the first choice in the tab order", () => {
    const html = render();
    expect(attrOf(html, 'id="choice-A"', "aria-checked")).toBe("false");
    expect(attrOf(html, 'id="choice-B"', "aria-checked")).toBe("false");
    expect(attrOf(html, 'id="choice-A"', "tabindex")).toBe("0");
    expect(attrOf(html, 'id="choice-B"', "tabindex")).toBe("-1");
  });

  it("checks the selected choice and moves the tab stop to it", () => {
    const html = render({ choice: "B" });
    expect(attrOf(html, 'id="choice-A"', "aria-checked")).toBe("false");
    expect(attrOf(html, 'id="choice-B"', "aria-checked")).toBe("true");
    expect(attrOf(html, 'id="choice-A"', "tabindex")).toBe("-1");
    expect(attrOf(html, 'id="choice-B"', "tabindex")).toBe("0");
  });

  it("offers neither the reason nor the submit action before a choice", () => {
    const html = render();
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Submit &amp; Get Paid");
  });
});

describe("choiceForKey — radiogroup keyboard model", () => {
  it.each([
    ["ArrowDown", "A", "B"],
    ["ArrowRight", "A", "B"],
    ["ArrowUp", "A", "B"],
    ["ArrowLeft", "A", "B"],
    ["ArrowDown", "B", "A"],
    ["ArrowRight", "B", "A"],
    ["ArrowUp", "B", "A"],
    ["ArrowLeft", "B", "A"],
  ] as const)("%s from %s moves to %s (two choices wrap)", (key, from, to) => {
    expect(choiceForKey(key, from)).toBe(to);
  });

  it.each([" ", "Enter"])("%j selects the focused choice", (key) => {
    expect(choiceForKey(key, "A")).toBe("A");
    expect(choiceForKey(key, "B")).toBe("B");
  });

  it.each(["Tab", "Escape", "a", "b", "1"])("%j is not a choice key, so Tab still leaves the group", (key) => {
    expect(choiceForKey(key, "A")).toBeNull();
  });
});

describe("TaskCardView — the reason", () => {
  it("labels the reason field and ties the length hint to it", () => {
    const html = render({ choice: "A" });
    expect(html).toMatch(/<label[^>]*for="reason"/);
    const hint = attrOf(html, 'id="reason"', "aria-describedby")!;
    expect(hint.split(" ").map((id) => textOf(html, id) ?? "").join(" ")).toContain("min 10 characters");
    expect(attrOf(html, 'id="reason"', "aria-invalid")).toBe("false");
  });

  it("leaves an empty reason unflagged: nothing has been typed yet", () => {
    const html = render({ choice: "A", reason: "   " });
    expect(attrOf(html, 'id="reason"', "aria-invalid")).toBe("false");
    expect(html).not.toContain('id="reason-error"');
  });

  it("marks a too-short reason invalid and says how long it must be", () => {
    const html = render({ choice: "A", reason: "too short" });
    expect(attrOf(html, 'id="reason"', "aria-invalid")).toBe("true");
    const ids = attrOf(html, 'id="reason"', "aria-describedby")!.split(" ");
    expect(ids).toContain("reason-error");
    expect(textOf(html, "reason-error")).toBe("Write at least 10 characters.");
  });

  it("marks a spammy reason invalid and points the field at the message", () => {
    const html = render({ choice: "A", reason: "aaaaaaaaaaaaaaa" });
    expect(attrOf(html, 'id="reason"', "aria-invalid")).toBe("true");
    const ids = attrOf(html, 'id="reason"', "aria-describedby")!.split(" ");
    expect(ids.map((id) => textOf(html, id) ?? "").join(" ")).toContain("meaningful explanation");
  });
});

describe("TaskCardView — narrow screens", () => {
  it("keeps the flow in reading order: prompt, pair, reason, then submit", () => {
    const html = render({ choice: "A", reason: reasonOk });
    const order = ["The Prompt", 'id="choice-A"', 'id="choice-B"', 'id="reason"', "Submit &amp; Get Paid"].map((m) =>
      html.indexOf(m),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("puts the submit bar in the document flow, so it can never cover the reason field", () => {
    const bar = tagWith(render({ choice: "A", reason: reasonOk }), 'data-testid="submit-bar"');
    // A `fixed` bar overlays the end of the page and needs padding guesswork
    // that an open reason field or an error line outgrows; `sticky` keeps its
    // own space at the end of the flow.
    expect(bar).not.toMatch(/\bfixed\b/);
    expect(bar).toMatch(/\bsticky\b/);
    expect(bar).toContain("safe-area-inset-bottom");
  });
});

describe("TaskCardView — errors and submission progress", () => {
  it("keeps the announcement regions mounted and empty while idle", () => {
    const html = render({ choice: "A", reason: reasonOk });
    expect(attrOf(html, 'data-testid="submit-status"', "role")).toBe("status");
    expect(attrOf(html, 'data-testid="submit-error"', "role")).toBe("alert");
    expect(html).toMatch(/data-testid="submit-status"[^>]*><\/p>/);
    expect(html).toMatch(/data-testid="submit-error"[^>]*><\/p>/);
  });

  it("announces a submission in flight and refuses a second one", () => {
    const html = render({ choice: "A", reason: reasonOk, loading: true });
    expect(html).toMatch(/data-testid="submit-status"[^>]*>Submitting your ranking…<\/p>/);
    const button = tagWith(html, 'id="submit-ranking"');
    expect(button).toMatch(/disabled=""/);
    expect(button).toContain('aria-busy="true"');
  });

  it("announces a failed submission as an alert", () => {
    const html = render({ choice: "A", reason: reasonOk, error: "Network error. Please try again." });
    expect(html).toMatch(/data-testid="submit-error"[^>]*>Network error\. Please try again\.<\/p>/);
    expect(tagWith(html, 'id="submit-ranking"')).not.toMatch(/disabled=""/);
  });

  it("disables submit until the reason is valid", () => {
    expect(tagWith(render({ choice: "A", reason: "short" }), 'id="submit-ranking"')).toMatch(/disabled=""/);
    expect(tagWith(render({ choice: "A", reason: reasonOk }), 'id="submit-ranking"')).not.toMatch(
      /disabled=""/,
    );
  });
});

"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import SubmitButton from "./SubmitButton";
import { REWARD_AMOUNT, REWARD_TOKEN_SYMBOL } from "@/lib/constants";
import { validateReason } from "@/lib/validators";

type Side = "A" | "B";

interface Task {
  id: string;
  prompt: string;
  responseA: string;
  responseB: string;
  submissionsRemaining?: number | null;
}

interface TaskCardProps {
  task: Task;
  onSubmit: (choice: Side, reason: string) => Promise<void>;
  loading: boolean;
  /** The last submission's failure, announced as an alert beside the submit action. */
  error?: string | null;
  reward?: string;
  tokenSymbol?: string;
}

const SIDES: readonly Side[] = ["A", "B"];

/**
 * #35: the pair is a radiogroup. Arrow keys move to the other response and
 * select it, as native radios do (two choices, so every arrow wraps); Space and
 * Enter select the focused one. Anything else — Tab above all — is left alone.
 */
export function choiceForKey(key: string, focused: Side): Side | null {
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
    case "ArrowUp":
    case "ArrowLeft":
      return focused === "A" ? "B" : "A";
    case " ":
    case "Enter":
      return focused;
  }
  return null;
}

/** One ranking task: holds the chosen response and the reason, and submits them. */
export default function TaskCard({ task, onSubmit, loading, error = null, reward, tokenSymbol }: TaskCardProps) {
  const [choice, setChoice] = useState<Side | null>(null);
  const [reason, setReason] = useState("");

  /** Submits only a complete ranking, and never a second one while one is in flight. */
  function handleSubmit() {
    if (!choice || !validateReason(reason) || loading) return;
    onSubmit(choice, reason.trim());
  }

  return (
    <TaskCardView
      task={task}
      choice={choice}
      reason={reason}
      loading={loading}
      error={error}
      reward={reward}
      tokenSymbol={tokenSymbol}
      onChoose={setChoice}
      onReasonChange={setReason}
      onSubmit={handleSubmit}
    />
  );
}

interface TaskCardViewProps {
  task: Task;
  choice: Side | null;
  reason: string;
  loading: boolean;
  error: string | null;
  reward?: string;
  tokenSymbol?: string;
  onChoose: (side: Side) => void;
  onReasonChange: (reason: string) => void;
  onSubmit: () => void;
}

/** The ranking surface for one state, so each state renders on its own in tests. */
export function TaskCardView({
  task,
  choice,
  reason,
  loading,
  error,
  reward,
  tokenSymbol,
  onChoose,
  onReasonChange,
  onSubmit,
}: TaskCardViewProps) {
  const displayReward = reward ?? REWARD_AMOUNT;
  const displaySymbol = tokenSymbol ?? REWARD_TOKEN_SYMBOL;
  const radios = useRef<Record<Side, HTMLDivElement | null>>({ A: null, B: null });

  // Run the shared validation logic locally for immediate user feedback
  const isReasonValid = validateReason(reason);
  // Anything typed that would be refused says why: too short, or too thin.
  const reasonLength = reason.trim().length;
  const reasonError =
    reasonLength === 0 || isReasonValid
      ? null
      : reasonLength < 10
        ? "Write at least 10 characters."
        : "Please enter a meaningful explanation. Avoid spam characters or keyboard mashing.";
  const showReasonError = reasonError !== null;
  const canSubmit = choice !== null && isReasonValid && !loading;

  /** Applies choiceForKey to a keydown on `side`'s radio and moves focus to the result. */
  function handleKeyDown(side: Side, e: KeyboardEvent<HTMLDivElement>) {
    const next = choiceForKey(e.key, side);
    if (!next) return;
    e.preventDefault();
    onChoose(next);
    radios.current[next]?.focus();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[20px] text-primary" aria-hidden="true">
            dataset
          </span>
          <span className="text-xs font-label font-bold uppercase tracking-[0.2em] text-outline">
            Label Task
          </span>
          {task.submissionsRemaining != null && (
            <span className="ml-1 rounded-full bg-secondary-container px-2 py-0.5 text-[10px] font-label font-bold text-on-secondary-container">
              {task.submissionsRemaining} remaining
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 rounded-xl bg-surface-container-lowest px-3 py-1.5 shadow-[0_4px_12px_rgba(25,28,30,0.03)]">
          <span
            className="material-symbols-outlined text-sm text-secondary"
            style={{ fontVariationSettings: "'FILL' 1" }}
            aria-hidden="true"
          >
            monetization_on
          </span>
          <span className="font-headline text-sm font-bold text-secondary">{displayReward} {displaySymbol}</span>
        </div>
      </div>

      <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
        <div className="mb-3 flex items-center gap-2">
          <span className="material-symbols-outlined text-[20px] text-primary" aria-hidden="true">
            chat
          </span>
          <span className="text-xs font-label font-bold uppercase tracking-[0.2em] text-outline">
            The Prompt
          </span>
        </div>
        <p className="break-words font-body text-base leading-relaxed text-on-surface">{task.prompt}</p>
      </section>

      <div role="radiogroup" aria-label="Which response is better?" className="flex flex-col gap-3">
        {SIDES.map((side) => {
          const isSelected = choice === side;
          // Roving tab stop: the checked response, or A before anything is checked.
          const isTabStop = choice ? isSelected : side === "A";
          return (
            <div
              key={side}
              ref={(el) => {
                radios.current[side] = el;
              }}
              id={`choice-${side}`}
              role="radio"
              aria-checked={isSelected}
              aria-labelledby={`choice-${side}-label`}
              aria-describedby={`choice-${side}-text`}
              tabIndex={isTabStop ? 0 : -1}
              onClick={() => onChoose(side)}
              onKeyDown={(e) => handleKeyDown(side, e)}
              className={`cursor-pointer rounded-2xl bg-surface-container-lowest p-6 shadow-[0_8px_24px_rgba(25,28,30,0.06)] outline-none transition-all duration-200 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface ${
                isSelected
                  ? "scale-[1.01] ring-2 ring-primary"
                  : "hover:shadow-[0_12px_32px_rgba(25,28,30,0.08)]"
              }`}
            >
              <div className="mb-3 flex items-center justify-between">
                <span
                  id={`choice-${side}-label`}
                  className="text-xs font-label font-bold uppercase tracking-[0.2em] text-outline"
                >
                  Response {side}
                </span>
                {isSelected && (
                  <span
                    className="flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-xs font-label font-bold text-on-primary"
                    aria-hidden="true"
                  >
                    <span className="material-symbols-outlined text-[14px]">check</span>
                    Selected
                  </span>
                )}
              </div>
              <p id={`choice-${side}-text`} className="break-words font-body text-sm leading-relaxed text-on-surface">
                {side === "A" ? task.responseA : task.responseB}
              </p>
              {/* The visible affordance; the card itself is the control. */}
              <span
                aria-hidden="true"
                className={`mt-4 block w-full rounded-xl px-4 py-3 text-center text-sm font-label font-semibold transition-colors duration-200 ${
                  isSelected
                    ? "bg-primary text-on-primary"
                    : "bg-surface-container-high text-on-surface-variant"
                }`}
              >
                {side} is better
              </span>
            </div>
          );
        })}
      </div>

      {choice && (
        <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
          <label htmlFor="reason" className="mb-2 block font-headline text-sm font-bold text-on-surface">
            Why? <span id="reason-hint" className="text-xs font-normal text-outline">(min 10 characters)</span>
          </label>
          <textarea
            id="reason"
            rows={3}
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            aria-invalid={showReasonError}
            aria-describedby={showReasonError ? "reason-hint reason-error" : "reason-hint"}
            placeholder="Explain your reasoning for selecting the better response..."
            className="w-full resize-none rounded-lg border-none bg-surface-container-highest px-4 py-3 font-body text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:ring-0 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          />

          {showReasonError && (
            <p id="reason-error" className="mt-2 text-xs font-medium text-error">
              {reasonError}
            </p>
          )}
        </section>
      )}

      {choice && (
        // Sticky, not fixed: the bar keeps its own space at the end of the flow,
        // so it never covers the reason field or an error line on a narrow screen.
        // globals.css pads the page's scroll region while it is shown, so tabbing
        // to a choice or the reason scrolls it clear of the bar.
        <div
          data-testid="submit-bar"
          data-sticky-submit
          className="sticky bottom-0 z-30 -mx-4 bg-gradient-to-t from-surface via-surface/95 to-transparent px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-6"
        >
          {/* Mounted before anything goes wrong, so a later message is announced. */}
          <p
            data-testid="submit-error"
            role="alert"
            className="mb-3 empty:hidden rounded-xl bg-error-container px-4 py-3 text-sm font-medium text-on-error-container"
          >{error ?? ""}</p>
          <p data-testid="submit-status" role="status" className="sr-only">{loading ? "Submitting your ranking…" : ""}</p>
          <SubmitButton
            id="submit-ranking"
            label="Submit & Get Paid"
            loadingLabel="Submitting"
            onClick={onSubmit}
            disabled={!canSubmit}
            loading={loading}
          />
        </div>
      )}
    </div>
  );
}

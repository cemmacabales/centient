"use client";

import { useState } from "react";
import SubmitButton from "./SubmitButton";
import { REWARD_AMOUNT, REWARD_TOKEN_SYMBOL } from "@/lib/constants";

interface TaskCardProps {
  task: {
    id: string;
    prompt: string;
    responseA: string;
    responseB: string;
  };
  onSubmit: (choice: "A" | "B", reason: string) => Promise<void>;
  loading: boolean;
  reward?: string;
  tokenSymbol?: string;
}

export default function TaskCard({
  task,
  onSubmit,
  loading,
  reward = REWARD_AMOUNT,
  tokenSymbol = REWARD_TOKEN_SYMBOL,
}: TaskCardProps) {
  const [choice, setChoice] = useState<"A" | "B" | null>(null);
  const [reason, setReason] = useState("");

  const canSubmit = choice !== null && reason.trim().length >= 10 && !loading;

  function handleSubmit() {
    if (!choice) return;
    onSubmit(choice, reason.trim());
  }

  return (
    <div className="flex flex-col gap-4 pb-32">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[20px] text-primary" aria-hidden="true">
            dataset
          </span>
          <span className="text-xs font-label font-bold uppercase tracking-[0.2em] text-outline">
            Label Task
          </span>
        </div>
        <div className="flex items-center gap-1.5 rounded-xl bg-surface-container-lowest px-3 py-1.5 shadow-[0_4px_12px_rgba(25,28,30,0.03)]">
          <span
            className="material-symbols-outlined text-sm text-secondary"
            style={{ fontVariationSettings: "'FILL' 1" }}
            aria-hidden="true"
          >
            monetization_on
          </span>
          <span className="font-headline text-sm font-bold text-secondary">{reward} {tokenSymbol}</span>
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
        <p className="font-body text-base leading-relaxed text-on-surface">{task.prompt}</p>
      </section>

      <div className="flex flex-col gap-3">
        {(["A", "B"] as const).map((side) => {
          const isSelected = choice === side;
          return (
            <section
              key={side}
              onClick={() => setChoice(side)}
              className={`cursor-pointer rounded-2xl bg-surface-container-lowest p-6 shadow-[0_8px_24px_rgba(25,28,30,0.06)] transition-all duration-200 ${
                isSelected
                  ? "scale-[1.01] ring-2 ring-primary"
                  : "hover:shadow-[0_12px_32px_rgba(25,28,30,0.08)]"
              }`}
            >
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-label font-bold uppercase tracking-[0.2em] text-outline">
                  Response {side}
                </span>
                {isSelected && (
                  <span className="flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-xs font-label font-bold text-on-primary">
                    <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                      check
                    </span>
                    Selected
                  </span>
                )}
              </div>
              <p className="font-body text-sm leading-relaxed text-on-surface">
                {side === "A" ? task.responseA : task.responseB}
              </p>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setChoice(side);
                }}
                aria-pressed={isSelected}
                className={`mt-4 w-full rounded-xl px-4 py-3 text-sm font-label font-semibold transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface ${
                  isSelected
                    ? "bg-primary text-on-primary"
                    : "bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest"
                }`}
              >
                {side} is better
              </button>
            </section>
          );
        })}
      </div>

      {choice && (
        <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
          <label htmlFor="reason" className="mb-2 block font-headline text-sm font-bold text-on-surface">
            Why? <span className="text-xs font-normal text-outline">(min 10 characters)</span>
          </label>
          <textarea
            id="reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Explain your reasoning for selecting the better response..."
            className="w-full resize-none rounded-lg border-none bg-surface-container-highest px-4 py-3 font-body text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:ring-0 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          />
        </section>
      )}

      {choice && (
        <div className="fixed inset-x-0 bottom-0 z-50 bg-gradient-to-t from-surface via-surface/95 to-transparent px-4 pb-6 pt-8">
          <SubmitButton
            label="Submit & Get Paid"
            onClick={handleSubmit}
            disabled={!canSubmit}
            loading={loading}
          />
        </div>
      )}
    </div>
  );
}

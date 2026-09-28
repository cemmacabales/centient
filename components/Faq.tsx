"use client";

import { REWARD_TOKEN_SYMBOL } from "@/lib/constants";

const ITEMS: { q: string; a: string }[] = [
  {
    q: "What is Centient?",
    a: "Label AI training data and get paid per task. You see two AI responses, pick the better one, and explain why.",
  },
  {
    q: "How much do I earn?",
    a: `Each task shows its ${REWARD_TOKEN_SYMBOL} reward before you answer. An accepted answer is paid straight to the wallet you signed in with — there is no balance to withdraw.`,
  },
  {
    q: "What makes a good submission?",
    a: "A short, clear reason (10+ characters) that explains why one response is better. Random or repetitive text may be rejected.",
  },
  {
    q: "How are payments sent?",
    a: `Each accepted answer is sent as its own ${REWARD_TOKEN_SYMBOL} payment on Stellar. Your account sheet shows each payment's status: pending, sent or confirmed.`,
  },
  {
    q: "What is a quality check?",
    a: "We occasionally mix in tasks with a clear right answer to keep quality high. They don't pay, and getting too many wrong may pause your account.",
  },
];

export default function Faq() {
  return (
    <section className="w-full rounded-2xl bg-surface-container-lowest p-2 shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
      <div className="px-4 pt-4">
        <span className="text-xs font-label font-bold uppercase tracking-[0.2em] text-outline">
          FAQ
        </span>
      </div>
      <ul className="mt-2">
        {ITEMS.map(({ q, a }, i) => (
          <li
            key={q}
            className={i === ITEMS.length - 1 ? "" : "border-b border-outline-variant/30"}
          >
            <details className="group px-4 py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                <span className="font-headline text-sm font-bold text-on-surface">
                  {q}
                </span>
                <span
                  className="material-symbols-outlined text-[22px] text-outline transition-transform duration-200 group-open:rotate-180"
                  aria-hidden="true"
                >
                  expand_more
                </span>
              </summary>
              <p className="mt-3 font-body text-sm leading-relaxed text-on-surface-variant">
                {a}
              </p>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

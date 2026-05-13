"use client";

import { useState } from "react";
import Image from "next/image";

// ─── FAQ data ────────────────────────────────────────────────────────────────
const FAQ_ITEMS = [
  {
    q: "What is Centient?",
    a: "Centient is a micro-task app inside the MiniPay wallet. You label AI training data by choosing between two responses, and get paid a small amount in cUSD for each valid task.",
  },
  {
    q: "How do I access it?",
    a: "Open the MiniPay wallet on Android, tap the browser icon, and navigate to centient.work. The app loads directly — no install required.",
  },
  {
    q: "How much do I earn per task?",
    a: "0.05 cUSD per approved submission. There is no daily limit in v1.",
  },
  {
    q: "How fast are payouts?",
    a: "Payments are sent on-chain immediately after you submit. Most transactions confirm on Celo within a few seconds.",
  },
  {
    q: 'What is a "quality check"?',
    a: "Occasionally you'll get a gold task — a pair where one response is clearly correct. These are used to ensure answer quality. If you fail, you won't be paid for that task and move to the next one.",
  },
  {
    q: "Why was my account paused?",
    a: "If your accuracy on quality checks drops below 50% over your last 10 attempts, your account is temporarily paused. Contact support@centient.work to appeal.",
  },
  {
    q: "Does it work on iOS or desktop?",
    a: "The payment flow requires MiniPay's injected wallet provider, which is only available on the MiniPay Android app. The landing page (this page) is viewable anywhere.",
  },
  {
    q: "Who builds Centient?",
    a: "Centient is an independent project built on Celo. It is not affiliated with Celo Foundation or Opera MiniPay.",
  },
];

// ─── Roadmap data ─────────────────────────────────────────────────────────────
const ROADMAP = [
  { status: "shipped", label: "Response-pair preference labeling" },
  { status: "shipped", label: "Instant cUSD payouts on Celo" },
  { status: "shipped", label: "Quality control via gold tasks" },
  { status: "planned", label: "New task types (rating, categorization)" },
  { status: "planned", label: "Leaderboard and streak bonuses" },
  { status: "planned", label: "Task variety packs (coding, creative writing, math)" },
  { status: "planned", label: "In-app earnings history and withdrawal summary" },
  { status: "planned", label: "iOS support (pending MiniPay iOS launch)" },
];

// ─── How It Works steps ───────────────────────────────────────────────────────
const STEPS = [
  {
    n: 1,
    heading: "Open Centient in MiniPay",
    body: "Install MiniPay on Android, then load centient.work from the built-in browser. Your wallet connects automatically — no login, no sign-up.",
  },
  {
    n: 2,
    heading: "Read the task and pick the better response",
    body: "You'll see one AI prompt and two responses. Read both and tap the one that's more accurate, clearer, or more helpful. Write a short reason (10+ characters).",
  },
  {
    n: 3,
    heading: "Get paid instantly in cUSD",
    body: "Tap Submit. A cUSD micropayment hits your MiniPay wallet in seconds. Each valid task pays 0.05 cUSD. Your balance updates in the app header.",
  },
];

export default function OutsideMiniPayPage() {
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  return (
    <div className="relative min-h-screen bg-surface">
      {/* Ambient background blobs */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -right-[10%] -top-[20%] h-[80vw] w-[80vw] rounded-full bg-primary/5 blur-[100px]" />
        <div className="absolute -left-[20%] top-[40%] h-[70vw] w-[70vw] rounded-full bg-secondary/5 blur-[80px]" />
      </div>

      <div className="relative z-10 mx-auto max-w-2xl px-5 pb-20">

        {/* ── HERO ──────────────────────────────────────────────────────────── */}
        <section className="flex flex-col items-center gap-6 pb-16 pt-16 text-center">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-full bg-surface-container-high px-3 py-1.5 shadow-[0_4px_12px_rgba(25,28,30,0.03)]">
              <span
                className="material-symbols-outlined text-[16px] text-secondary"
                style={{ fontVariationSettings: "'FILL' 1" }}
                aria-hidden="true"
              >
                payments
              </span>
              <span className="text-xs font-label font-bold tracking-wide text-on-surface-variant">
                cUSD Ready
              </span>
            </div>
          </div>

          <Image
            src="/logo.png"
            alt="Centient logo"
            width={96}
            height={96}
            priority
            className="select-none drop-shadow-[0_8px_24px_rgba(0,109,61,0.15)]"
          />

          <div>
            <h1 className="text-[2.5rem] font-headline font-extrabold leading-[1.1] tracking-tight text-on-surface">
              Centient runs{" "}
              <span className="bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
                inside MiniPay
              </span>
            </h1>
            <p className="mt-3 font-body text-base text-on-surface-variant">
              Label AI training data and get paid instantly in cUSD.
              <br />
              Turn your precision into tangible value.
            </p>
          </div>

          <a
            href="https://minipay.to"
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-14 w-full max-w-xs items-center justify-center gap-2 rounded-full bg-gradient-to-br from-primary to-primary-container font-label text-lg font-bold text-white shadow-[0_8px_24px_rgba(0,109,61,0.2)] transition-transform duration-200 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            Get MiniPay
            <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
              arrow_forward
            </span>
          </a>
        </section>

        {/* ── HOW IT WORKS ─────────────────────────────────────────────────── */}
        <section className="mb-10">
          <div className="mb-1 text-xs font-label font-bold uppercase tracking-[0.2em] text-outline">
            How it works
          </div>
          <h2 className="mb-6 text-2xl font-headline font-bold text-on-surface">
            Three steps to earn
          </h2>

          <div className="flex flex-col gap-4">
            {STEPS.map((step) => (
              <div
                key={step.n}
                className="flex gap-4 rounded-2xl bg-surface-container-lowest p-6 shadow-[0_8px_24px_rgba(25,28,30,0.06)]"
              >
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary font-label text-sm font-bold text-on-primary">
                  {step.n}
                </div>
                <div>
                  <div className="font-headline text-base font-bold text-on-surface">
                    {step.heading}
                  </div>
                  <p className="mt-1 font-body text-sm text-on-surface-variant">{step.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── FAQ ───────────────────────────────────────────────────────────── */}
        <section className="mb-10">
          <div className="mb-1 text-xs font-label font-bold uppercase tracking-[0.2em] text-outline">
            FAQ
          </div>
          <h2 className="mb-6 text-2xl font-headline font-bold text-on-surface">
            Common questions
          </h2>

          <div className="rounded-2xl bg-surface-container-lowest shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
            {FAQ_ITEMS.map((item, i) => (
              <div key={i} className={i !== 0 ? "border-t border-outline-variant/30" : ""}>
                <button
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  className="flex w-full items-center justify-between gap-4 px-6 py-4 text-left focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                  aria-expanded={openFaq === i}
                >
                  <span className="font-headline text-sm font-bold text-on-surface">
                    {item.q}
                  </span>
                  <span
                    className="material-symbols-outlined flex-shrink-0 text-[20px] text-outline transition-transform duration-200"
                    style={{ transform: openFaq === i ? "rotate(180deg)" : "rotate(0deg)" }}
                    aria-hidden="true"
                  >
                    {openFaq === i ? "expand_less" : "expand_more"}
                  </span>
                </button>
                {openFaq === i && (
                  <div className="rounded-b-xl bg-surface-container-low px-6 pb-5">
                    <p className="font-body text-sm text-on-surface-variant">{item.a}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* ── ROADMAP ───────────────────────────────────────────────────────── */}
        <section className="mb-12">
          <div className="mb-1 text-xs font-label font-bold uppercase tracking-[0.2em] text-outline">
            Roadmap
          </div>
          <h2 className="mb-6 text-2xl font-headline font-bold text-on-surface">
            What&apos;s shipped and what&apos;s next
          </h2>

          <div className="relative rounded-2xl bg-surface-container-lowest p-6 shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
            {/* Vertical line */}
            <div className="absolute bottom-6 left-[2.35rem] top-6 w-px bg-outline-variant/40" />

            <div className="flex flex-col gap-5">
              {ROADMAP.map((item, i) => (
                <div key={i} className="relative flex items-start gap-4">
                  {/* Dot */}
                  <div
                    className={`relative z-10 mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full ${
                      item.status === "shipped"
                        ? "bg-primary"
                        : "border border-outline-variant bg-surface-container-highest"
                    }`}
                  >
                    {item.status === "shipped" && (
                      <span
                        className="material-symbols-outlined text-[12px] text-on-primary"
                        style={{ fontVariationSettings: "'FILL' 1" }}
                        aria-hidden="true"
                      >
                        check
                      </span>
                    )}
                  </div>

                  <div className="flex flex-1 items-center justify-between gap-3">
                    <span
                      className={`font-body text-sm ${
                        item.status === "shipped" ? "text-on-surface" : "text-on-surface-variant"
                      }`}
                    >
                      {item.label}
                    </span>
                    {item.status === "shipped" && (
                      <span className="flex-shrink-0 rounded-full bg-primary-container/40 px-2.5 py-0.5 text-xs font-label font-semibold text-on-primary-container">
                        Shipped
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── BOTTOM CTA ────────────────────────────────────────────────────── */}
        <section className="flex flex-col items-center gap-4 text-center">
          <h2 className="text-2xl font-headline font-bold text-on-surface">
            Ready to start earning?
          </h2>
          <p className="font-body text-sm text-on-surface-variant">
            Open centient.work in MiniPay and earn your first cUSD in minutes.
          </p>
          <a
            href="https://minipay.to"
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-14 w-full max-w-xs items-center justify-center gap-2 rounded-full bg-gradient-to-br from-primary to-primary-container font-label text-lg font-bold text-white shadow-[0_8px_24px_rgba(0,109,61,0.2)] transition-transform duration-200 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            Get MiniPay
            <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
              arrow_forward
            </span>
          </a>
        </section>
      </div>

      {/* ── FOOTER ──────────────────────────────────────────────────────────── */}
      <footer className="relative z-10 bg-surface-container-low py-6 text-center">
        <p className="text-xs font-label font-bold uppercase tracking-[0.2em] text-outline">
          centient.work
        </p>
        <a
          href="mailto:support@centient.work"
          className="mt-1 block font-body text-sm text-outline"
        >
          support@centient.work
        </a>
      </footer>
    </div>
  );
}
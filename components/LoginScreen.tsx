"use client";

import Image from "next/image";
import Faq from "./Faq";
import Mascot from "./LandingMascot";
import WalletSignIn from "./WalletSignIn";
import { REWARD_AMOUNT, REWARD_TOKEN_SYMBOL } from "@/lib/constants";

interface LoginScreenProps {
  /** Called once Freighter sign-in has set the session cookie (#26). */
  onWalletSignedIn: () => void;
  /** Open email sign-in — only so an account created by email can claim a wallet (#30). */
  onEmailSignIn: () => void;
  error: string | null;
}

const FOCUS_RING =
  "rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

/** One task, in order: the steps are a real sequence, so they are numbered. */
const STEPS: { icon: string; title: string; body: string }[] = [
  {
    icon: "chat",
    title: "Read the prompt",
    body: "Each task shows a question someone asked an AI, and two responses it gave.",
  },
  {
    icon: "rule",
    title: "Pick the better response",
    body: "Choose response A or B, then write a short reason saying why it's better.",
  },
  {
    icon: "payments",
    title: "Get paid",
    body: `Each approved answer adds ${REWARD_AMOUNT} ${REWARD_TOKEN_SYMBOL} to your balance, paid to the wallet you signed in with.`,
  },
];

/**
 * Wallet-first entry (#26). A contributor signs in by connecting Freighter and
 * signing a one-time challenge (#25) — no email or password. The proven `G…`
 * address is the account: a new address gets a new contributor account, and an
 * email account that linked that address signs in as itself.
 *
 * #30: nobody signs up with email any more. Email sign-in stays only for an
 * account created before wallet sign-in, which must connect its wallet before it
 * can earn or withdraw.
 */
export default function LoginScreen({ onWalletSignedIn, onEmailSignIn, error }: LoginScreenProps) {
  return (
    <div className="min-h-screen overflow-x-clip bg-surface text-on-surface">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <div className="flex items-center gap-2">
          <Image src="/logo.png" alt="" width={36} height={36} className="select-none" />
          <span className="font-headline text-xl font-extrabold tracking-tighter text-primary">
            Centient
          </span>
        </div>
        <nav aria-label="Page sections" className="hidden items-center gap-6 sm:flex">
          <a
            href="#how-it-works"
            className={`font-label text-sm font-semibold text-on-surface-variant transition-colors hover:text-primary ${FOCUS_RING}`}
          >
            How it works
          </a>
          <a
            href="#faq"
            className={`font-label text-sm font-semibold text-on-surface-variant transition-colors hover:text-primary ${FOCUS_RING}`}
          >
            FAQ
          </a>
        </nav>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-6 px-5 pb-16 pt-6 sm:px-8 lg:min-h-[calc(100dvh-5rem)] lg:grid-cols-[1.2fr_1fr] lg:gap-4 lg:pb-24 lg:pt-0">
          <div className="flex flex-col items-start">
            <div className="flex items-center gap-1.5 rounded-full bg-surface-container-high px-3 py-1.5 shadow-[0_4px_12px_rgba(25,28,30,0.03)]">
              <span
                className="material-symbols-outlined text-[16px] text-secondary"
                style={{ fontVariationSettings: "'FILL' 1" }}
                aria-hidden="true"
              >
                payments
              </span>
              <span className="font-label text-xs font-bold tracking-wide text-on-surface-variant">
                Paid in {REWARD_TOKEN_SYMBOL} on Stellar
              </span>
            </div>

            <h1 className="mt-6 font-headline text-[2.75rem] font-extrabold leading-[0.95] tracking-[-0.045em] text-on-surface sm:text-[4.5rem] lg:text-[4rem] xl:text-[4.75rem]">
              Train AI,
              <br />
              <span className="whitespace-nowrap text-secondary">cent by cent.</span>
            </h1>

            <p className="mt-6 max-w-[34rem] font-body text-lg leading-relaxed text-on-surface-variant">
              Read a prompt, pick the better of two AI responses, and say why. Each approved
              answer pays {REWARD_AMOUNT} {REWARD_TOKEN_SYMBOL}. Connect your Stellar wallet to
              start — no email or password needed.
            </p>

            {error && (
              <p role="alert" className="mt-4 max-w-xs font-body text-sm text-error">
                {error}
              </p>
            )}

            <div className="mt-8 flex w-full flex-col items-start gap-4">
              {/* PRIMARY (#26): wallet-first */}
              <WalletSignIn onSignedIn={() => onWalletSignedIn()} />

              <p className="font-body text-sm text-on-surface-variant">
                Signed up with email before?{" "}
                <button
                  type="button"
                  onClick={onEmailSignIn}
                  className={`font-semibold text-primary underline-offset-2 hover:underline ${FOCUS_RING}`}
                >
                  Sign in with email
                </button>{" "}
                to connect your wallet.
              </p>
            </div>

            {/* The wallet is the account */}
            <div className="mt-8 flex max-w-[34rem] items-start gap-3 border-l-2 border-primary-container pl-4">
              <p className="font-body text-sm leading-relaxed text-on-surface-variant">
                Your <span className="font-semibold text-on-surface">wallet address</span>{" "}
                is your account and where your {REWARD_TOKEN_SYMBOL} is paid. Freighter asks you to sign a
                one-time message to prove it&apos;s yours — it never moves funds.
              </p>
            </div>
          </div>

          <Mascot />
        </section>

        <section
          id="how-it-works"
          className="scroll-mt-6 bg-surface-container-low px-5 py-20 sm:px-8"
        >
          <div className="mx-auto max-w-6xl">
            <h2 className="font-headline text-3xl font-extrabold tracking-tight sm:text-4xl">
              How a task works
            </h2>
            <p className="mt-2 font-body text-base text-on-surface-variant">
              Every task is the same three steps.
            </p>

            <ol className="mt-10 grid gap-4 md:grid-cols-3">
              {STEPS.map((step, i) => (
                <li
                  key={step.title}
                  className="rounded-2xl bg-surface-container-lowest p-6 shadow-[0_8px_24px_rgba(25,28,30,0.06)]"
                >
                  <div className="flex items-center justify-between">
                    <span
                      className="font-headline text-5xl font-extrabold tracking-tighter text-primary/25"
                      aria-hidden="true"
                    >
                      {i + 1}
                    </span>
                    <span
                      className={`material-symbols-outlined text-[28px] ${
                        step.icon === "payments" ? "text-secondary" : "text-primary"
                      }`}
                      aria-hidden="true"
                    >
                      {step.icon}
                    </span>
                  </div>
                  <h3 className="mt-6 font-headline text-lg font-bold">{step.title}</h3>
                  <p className="mt-2 font-body text-sm leading-relaxed text-on-surface-variant">
                    {step.body}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section
          id="faq"
          className="mx-auto grid max-w-6xl scroll-mt-6 gap-8 px-5 py-20 sm:px-8 lg:grid-cols-[1fr_1.5fr]"
        >
          <div>
            <h2 className="font-headline text-3xl font-extrabold tracking-tight sm:text-4xl">
              Questions
            </h2>
            <p className="mt-2 font-body text-base text-on-surface-variant">
              Anything else, email{" "}
              <a
                href="mailto:centient@artisam.xyz"
                className={`font-semibold text-primary underline-offset-2 hover:underline ${FOCUS_RING}`}
              >
                centient@artisam.xyz
              </a>
              .
            </p>
          </div>
          <Faq />
        </section>
      </main>

      <footer className="mx-auto flex max-w-6xl items-center justify-between border-t border-outline-variant/40 px-5 py-8 sm:px-8">
        <span className="font-headline text-base font-extrabold tracking-tighter text-primary">
          Centient
        </span>
        <span className="font-label text-xs font-bold uppercase tracking-[0.2em] text-outline">
          centient.work
        </span>
      </footer>
    </div>
  );
}

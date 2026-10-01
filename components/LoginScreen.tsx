"use client";

import Image from "next/image";
import AnswerJourney from "./AnswerJourney";
import Faq from "./Faq";
import LandingPhone from "./LandingPhone";
import PayoutFeed from "./PayoutFeed";
import WalletSignIn from "./WalletSignIn";
import { deployedBuild } from "@/lib/build-info";
import { REWARD_TOKEN_SYMBOL } from "@/lib/constants";
import { useLogoReady } from "@/lib/use-logo-ready";

/** The header logo. The loading screen preloads this exact rendition. */
export const HEADER_LOGO = { src: "/logo.png", width: 36, height: 36 };

interface LoginScreenProps {
  /** Called once Freighter sign-in has set the session cookie (#26). */
  onWalletSignedIn: () => void;
  /** Open email sign-in — only so an account created by email can claim a wallet (#30). */
  onEmailSignIn: () => void;
  error: string | null;
}

/** The Centient promo video on the Artisam Labs YouTube channel. */
const PROMO_VIDEO_ID = "uxjxu33TOuM";

/** The public Centient docs on GitBook, synced from `docs/instawards`. */
const DOCS_URL = "https://centient.gitbook.io/centient-docs/";

const FOCUS_RING =
  "rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

/** In page order. The ids are stable anchors other pages and docs link to. */
const SECTIONS = [
  { href: "#payouts", label: "Payouts" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#watch", label: "Watch" },
  { href: "#faq", label: "FAQ" },
];

const LINE_UP = "block motion-safe:animate-[landing-line-up_900ms_cubic-bezier(0.16,1,0.3,1)_both]";

/**
 * Wallet-first entry (#26). A contributor signs in by connecting Freighter and
 * signing a one-time challenge (#25) — no email or password. The proven `G…`
 * address is the account: a new address gets a new contributor account, and an
 * email account that linked that address signs in as itself.
 *
 * #30: nobody signs up with email any more. Email sign-in stays only for an
 * account created before wallet sign-in, which must connect its wallet before it
 * can earn or withdraw.
 *
 * The page follows one answer: the hero's phone plays a sample task end to
 * end, the feed below it lists real payouts from the ledger, and the sections
 * after that itemize what happens to an answer.
 */
export default function LoginScreen({ onWalletSignedIn, onEmailSignIn, error }: LoginScreenProps) {
  const build = deployedBuild();
  const logo = useLogoReady();
  return (
    <div className="min-h-screen overflow-x-clip bg-surface text-on-surface">
      <header className="landing-header sticky top-0 z-40 bg-surface">
        <div className="mx-auto flex h-[4.5rem] max-w-6xl items-center justify-between px-5 sm:px-8">
          {/* The wordmark waits for the logo so the two appear together. */}
          <a href="#top" className={`flex items-center gap-2 ${FOCUS_RING} ${logo.ready ? "" : "invisible"}`}>
            <Image
              {...HEADER_LOGO}
              alt=""
              loading="eager"
              {...logo.imageProps}
              className="select-none"
            />
            <span className="font-headline text-xl font-extrabold tracking-tighter text-primary">Centient</span>
          </a>
          <div className="flex items-center gap-7">
            <nav aria-label="Page sections" className="hidden items-center gap-7 md:flex">
              {SECTIONS.map((s) => (
                <a
                  key={s.href}
                  href={s.href}
                  className={`relative font-label text-sm font-semibold text-on-surface-variant transition-colors after:absolute after:inset-x-0 after:-bottom-1 after:h-0.5 after:origin-left after:scale-x-0 after:rounded-full after:bg-primary after:transition-transform after:duration-300 after:ease-[cubic-bezier(0.16,1,0.3,1)] hover:text-primary hover:after:scale-x-100 ${FOCUS_RING}`}
                >
                  {s.label}
                </a>
              ))}
            </nav>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 font-label text-sm font-bold text-on-primary shadow-[0_4px_12px_rgba(0,109,61,0.15)] transition-[translate,scale,box-shadow] duration-200 hover:-translate-y-px hover:shadow-[0_8px_20px_rgba(0,109,61,0.22)] active:translate-y-0 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                menu_book
              </span>
              Docs
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </div>
        </div>
      </header>

      <main id="top" className="scroll-mt-20">
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-5 pb-20 pt-6 sm:px-8 lg:min-h-[calc(100dvh-4.5rem)] lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:gap-10 xl:grid-cols-[minmax(0,1fr)_minmax(0,34rem)] lg:pb-14 lg:pt-2">
          <div className="flex flex-col items-start">
            <h1 className="font-headline text-[3.25rem] font-extrabold leading-[0.95] tracking-[-0.04em] text-on-surface sm:text-[5rem] lg:text-[4.5rem] xl:text-[5.25rem]">
              <span className="block overflow-clip pb-[0.04em]">
                <span className={LINE_UP}>Train AI,</span>
              </span>
              <span className="-mb-[0.1em] block overflow-clip pb-[0.14em]">
                <span className={`${LINE_UP} whitespace-nowrap text-secondary [animation-delay:120ms]`}>
                  cent by cent.
                </span>
              </span>
            </h1>

            <p className="mt-7 max-w-[30rem] font-body text-lg leading-relaxed text-on-surface-variant sm:text-xl">
              Pick the better of two AI responses and say why. Each approved answer pays {REWARD_TOKEN_SYMBOL}{" "}
              straight to your wallet.
            </p>

            {error && (
              <p role="alert" className="mt-5 max-w-sm font-body text-sm text-error">
                {error}
              </p>
            )}

            <div className="mt-9 flex w-full flex-col items-start gap-4">
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
          </div>

          <LandingPhone />
        </section>

        <PayoutFeed />

        <AnswerJourney />

        {/* youtube-nocookie sets no cookies until the visitor presses play. */}
        <section
          id="watch"
          aria-labelledby="watch-heading"
          className="scroll-mt-20 bg-surface-container-low px-5 py-24 sm:px-8 sm:py-28"
        >
          <div className="mx-auto max-w-5xl">
            <h2
              id="watch-heading"
              className="text-center font-headline text-3xl font-extrabold tracking-[-0.03em] sm:text-[2.75rem] sm:leading-[1.05]"
            >
              Meet Centient
            </h2>
            <div className="landing-frame mt-10 aspect-video w-full overflow-hidden rounded-[2rem] bg-surface-container-highest shadow-[0_24px_60px_rgba(0,109,61,0.14)]">
              <iframe
                src={`https://www.youtube-nocookie.com/embed/${PROMO_VIDEO_ID}?rel=0`}
                title="Centient promo video"
                loading="lazy"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                referrerPolicy="strict-origin-when-cross-origin"
                allowFullScreen
                className="h-full w-full border-0"
              />
            </div>
          </div>
        </section>

        <section
          id="faq"
          aria-labelledby="faq-heading"
          className="mx-auto max-w-3xl scroll-mt-20 px-5 py-24 sm:px-8 sm:py-28"
        >
          <h2
            id="faq-heading"
            className="text-center font-headline text-3xl font-extrabold tracking-[-0.03em] sm:text-[2.75rem] sm:leading-[1.05]"
          >
            Questions
          </h2>
          <p className="mt-3 text-center font-body text-base text-on-surface-variant">
            Anything else, email{" "}
            <a
              href="mailto:centient@artisam.xyz"
              className={`font-semibold text-primary underline-offset-2 hover:underline ${FOCUS_RING}`}
            >
              centient@artisam.xyz
            </a>
            .
          </p>
          <div className="faq-smooth mt-10">
            <Faq showLabel={false} />
          </div>
        </section>

        {/* The close: the receipt's last stub, torn off and handed over. */}
        <section aria-labelledby="start-heading" className="px-5 pb-24 pt-2 sm:px-8">
          <div className="mx-auto max-w-xl drop-shadow-[0_24px_40px_rgba(25,28,30,0.09)]">
            <div className="receipt-stub bg-surface-container-lowest px-6 pb-12 pt-11 sm:px-10">
              <div className="flex items-center gap-1.5 border-b border-dashed border-outline-variant pb-4">
                <Image src="/logo.png" alt="" width={22} height={22} className="select-none" />
                <span className="font-headline text-base font-extrabold tracking-tighter text-primary">Centient</span>
              </div>
              <h2
                id="start-heading"
                className="mt-8 font-headline text-3xl font-extrabold tracking-[-0.03em] text-on-surface sm:text-[2.5rem] sm:leading-[1.05]"
              >
                Your wallet is your account
              </h2>
              <p className="mt-4 font-body text-base leading-relaxed text-on-surface-variant sm:text-lg">
                Your <span className="font-semibold text-on-surface">wallet address</span>{" "}
                {`is your account and where your ${REWARD_TOKEN_SYMBOL} is paid. Freighter asks you to sign a one-time message to prove it's yours. It never moves funds, and there's no email or password needed.`}
              </p>
              <div className="mt-8 border-t border-dashed border-outline-variant pt-8">
                {/* The hero's sign-in already carries the phone pairing prompt. */}
                <WalletSignIn onSignedIn={() => onWalletSignedIn()} pairing={false} />
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-6xl items-center justify-between border-t border-outline-variant/40 px-5 py-8 sm:px-8">
        <span className="font-headline text-base font-extrabold tracking-tighter text-primary">Centient</span>
        <div className="flex flex-col items-end gap-1">
          <span className="font-label text-xs font-bold uppercase tracking-[0.2em] text-outline">centient.work</span>
          {build && (
            <a
              href={build.commitUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={build.sha}
              className={`font-mono text-xs text-outline underline-offset-2 hover:underline ${FOCUS_RING}`}
            >
              Build {build.shortSha}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
        </div>
      </footer>
    </div>
  );
}

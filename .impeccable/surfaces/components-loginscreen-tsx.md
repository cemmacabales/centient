---
version: 1
slug: "components-loginscreen-tsx"
primary_target: "components/LoginScreen.tsx"
related_targets: ["components/LandingMascot.tsx","components/Faq.tsx"]
---

# Landing (signed-out entry)

Scope: the signed-out landing that doubles as the Freighter sign-in screen (components/LoginScreen.tsx and its landing-only children). Visitor mode: Persuade.

Audience and action: labelers, mostly first-time crypto users on phones; the one action is Connect Freighter. Email sign-in stays as a quiet secondary for pre-wallet accounts.

Proof on hand: an automated sample task (seeded prompts, labeled as a sample), real outgoing USDC payments from the payout account read from Horizon testnet, the promo video, the docs.

Constraints: keep brand.md (green actions, gold money, Manrope/Inter, owl, light only); keep anchor ids #watch #how-it-works #faq; keep the build SHA footer (#48); CSP allows no third-party connect or images, so live data goes through a same-origin route.

User steer (2026-10-01): the sample task is not interactive. It plays itself end to end as an animation, then shows everything, with no visitor input.

User steer (2026-10-01, later): drop the receipt look in the hero. Show the sample task on a phone mockup whose screen scrolls through it instead.

## Direction contract

THESIS: The page follows one answer to its payment: the hero shows the real task screen on a phone, answered and paid live, and the receipts below prove the payouts. It refuses the category default of a split hero with a mascot illustration and three equal feature cards.

OWN-WORLD: brand.md tokens only. Off-white ground (#f8f9fb), white receipt paper with a perforated tear, green (#006d3d to #35d07f) only on actions and confirmations, gold (#785a00) on every amount, Manrope 800 display and numerals, Inter body, system mono only for hashes and addresses. Receipts, stubs and line items are the component language.

STORY: A visitor watches a task get read, answered and submitted on a phone, and the reward confirmed on its way, in about twelve seconds, sees real testnet payouts below it, follows what happens to one answer line by line, then connects Freighter.

FIRST VIEWPORT: Left half: two-line "Train AI, / cent by cent." at display scale, a 19-word subline, Connect Freighter with the email fallback beneath. Right half: a phone running the task screen, scrolling and tapping through the sample task to the success screen; the owl at its lower left changes pose with each stage. Caption under it names it a sample.

FORM: Payslip, position 6 on the ordered structure list, dealt as THE ROLL; seed key 0934abce.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved

- Which payout account production reads (STELLAR_PLATFORM_ACCOUNT on Railway); the feed shows an empty state when it is unset.

---
name: Centient
description: Train AI, cent by cent. Per-answer USDC payouts on Stellar, shown as receipts.
colors:
  primary: "#006d3d"
  on-primary: "#ffffff"
  primary-container: "#35d07f"
  secondary: "#785a00"
  secondary-container: "#fdce5e"
  secondary-fixed: "#ffdf9b"
  error: "#ba1a1a"
  error-container: "#ffdad6"
  on-error-container: "#93000a"
  surface: "#f8f9fb"
  surface-container-lowest: "#ffffff"
  surface-container-low: "#f3f4f6"
  surface-container-high: "#e7e8ea"
  surface-container-highest: "#e1e2e4"
  on-surface: "#191c1e"
  on-surface-variant: "#3d4a3f"
  inverse-surface: "#2e3132"
  outline: "#6c7b6e"
  outline-variant: "#bbcabc"
  tertiary: "#494bd6"
  on-tertiary: "#ffffff"
  tertiary-container: "#aeb0ff"
  tertiary-fixed: "#e1e0ff"
  on-tertiary-fixed: "#07006c"
  on-tertiary-fixed-variant: "#2f2ebe"
typography:
  display:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(3.25rem, 7vw, 5.25rem)"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "-0.04em"
  display-sm:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "5rem"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "-0.04em"
  display-lg:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "4.5rem"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "-0.04em"
  display-xl:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "5.25rem"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.75rem"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "-0.03em"
  headline-stub:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.5rem"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.33
  amount:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.05em"
    fontFeature: "\"tnum\""
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.625
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.43
  micro-label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "0.2em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.33
  icon:
    fontFamily: "Material Symbols Outlined"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "normal"
    fontFeature: "\"liga\""
  icon-button:
    fontFamily: "Material Symbols Outlined"
    fontSize: "22px"
    fontWeight: 400
    lineHeight: 1
  icon-title:
    fontFamily: "Material Symbols Outlined"
    fontSize: "26px"
    fontWeight: 400
    lineHeight: 1
rounded:
  sm: "0.25rem"
  md: "0.5rem"
  lg: "0.75rem"
  xl: "1rem"
  2xl: "1.5rem"
  3xl: "2rem"
  full: "9999px"
spacing:
  gutter: "1.25rem"
  gutter-sm: "2rem"
  section: "6rem"
  section-sm: "7rem"
  stub-x: "1.25rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    height: "56px"
    width: "100%"
  button-pill:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "8px 16px"
  link-inline:
    textColor: "{colors.primary}"
    typography: "{typography.label}"
  receipt-stub:
    backgroundColor: "{colors.surface-container-lowest}"
    textColor: "{colors.on-surface}"
    padding: "24px 20px"
    width: "15.5rem"
  receipt-amount:
    textColor: "{colors.secondary}"
    typography: "{typography.amount}"
  line-item-fields:
    backgroundColor: "{colors.surface-container-lowest}"
    textColor: "{colors.on-surface}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
  line-item-disc:
    backgroundColor: "{colors.on-surface}"
    textColor: "{colors.surface}"
    rounded: "{rounded.full}"
    size: "40px"
  phone-frame:
    backgroundColor: "{colors.inverse-surface}"
    rounded: "2.6rem"
    padding: "0.55rem"
    width: "16.5rem"
  phone-screen:
    backgroundColor: "{colors.surface}"
    rounded: "2.05rem"
    width: "360px"
    height: "760px"
  content-card:
    backgroundColor: "{colors.surface-container-lowest}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.2xl}"
    padding: "24px"
---

# Design System: Centient

## Overview

**Creative North Star: "The Payslip"**

Centient is recorded as two layers. The **incumbent brand system** (brand.md, installed as the Tailwind 4 `@theme` block in `app/globals.css`) supplies every color, both typefaces, the radius scale, the soft shadow scale, Material Symbols Outlined icons, the owl mascot and the green action gradient. This build kept all of it. The **receipt language** is what the landing / sign-in revamp (`components/LoginScreen.tsx` and its children) added: stubs torn at both ends, dotted leaders between a field name and its value, dashed rules between groups, uppercase micro-labels naming fields, and system mono only for hashes and addresses.

The payment is the hero. The page follows one answer: a phone in the hero plays a sample task end to end on the real task screen, real testnet payouts sit below it as stubs, the journey itemizes the same answer, and the close is the last stub handed over with the sign-in on it. Density is calm: off-white ground, one white paper at a time, generous section padding, a single max-width column. Motion is short, eased hard out, and every piece of it has a still, finished state for reduced motion.

Scope: the receipt language lives on the landing's stubs, journey and close, and the FAQ, and, since the XP loop (#201), on the in-app success screen's Accepted Stub and the quality-check XP row. The task screen and admin console were not redesigned and still follow brand.md's card patterns only; do not claim they use receipts. The XP loop's in-app pieces (Home's XP and week cards, the task screen's today strip and XP pill, the stub) ship behind `NEXT_PUBLIC_GAMIFICATION=on`; with it off the app is as before. The hero phone shows the task and success screens as they ship with the flag off, in miniature.

**Key Characteristics:**
- Off-white ground, white paper, no tinted card surfaces.
- Green only on actions and confirmations; gold on every amount.
- Manrope 800 for display and all numerals; Inter for body and labels; mono only for hashes, addresses and the build SHA.
- Stub edges are cut with masks (torn teeth), not drawn with borders.
- Receipt rows: field name, dotted leader, value.
- Every animation resolves to a finished, legible still frame under reduced motion.

## Colors

A cool off-white and white paper palette, carried by deep green for action and warm gold for money, with ink (near-black) doing the structural work.

### Primary
- **Ledger Green** (primary): the wordmark, primary buttons (as the gradient start), inline links, focus rings, Confirmed, and, inside the hero phone, the Selected chip and the chosen response's ring. Nothing decorative.
- **Signal Green** (primary-container): only as the end of the action gradient on the primary button, and in the text-selection tint.

### Secondary
- **Payout Gold** (secondary): every amount and its unit (stub amounts, the money line's icon). In the hero it also colors the tagline line "cent by cent.", which is the one wordplay accent per screen brand.md allows (it replaces brand.md's gradient text accent here).
- **Gold Wash** (secondary-fixed): transient only. A new payout stub carries secondary-fixed at 50% and fades.

### Tertiary
brand.md reserved indigo; the XP loop (#201) gives it one job: progress.
- **Progress Indigo** (tertiary): XP figures and the tier card's fill, met days on the week card, the today strip's segments and streak count, the goal-met toast, the tier-up band, earned stamps and the hold card's passes (#202), the weekly board's ranks, XP and your row, the event-code card, quest progress and the invite card's count (#203).
- **Indigo Mist** (tertiary-fixed): today's and a rest day's disc fill, and secondary text on an indigo surface.
- **Indigo Ink** (on-tertiary-fixed-variant, on-tertiary-fixed): numerals and icons on Indigo Mist.

### Neutral
- **Canvas** (surface): page ground, header background, and the hero phone's screen.
- **Paper** (surface-container-lowest): stubs, line-item field panels, the FAQ card.
- **Band** (surface-container-low): alternate full-bleed section bands (payouts, video) and unselected response options.
- **Skeleton** (surface-container-high): loading placeholders, pulsing.
- **Ink** (on-surface): body text, the journey rail fill and its reached discs.
- **Ink Muted** (on-surface-variant): secondary text, field names, helper copy.
- **Pencil** (outline): micro-labels, timestamps, tx hashes.
- **Rule Line** (outline-variant): dashed rules, dotted leaders, unreached rail and disc rings, empty-state dashed frames.
- **Handset** (inverse-surface): the hero phone's frame and side keys; its camera island and home indicator are on-surface.
- **Error** (error, error-container, on-error-container): sign-in errors and failure states only.

### Named Rules
**The Green Means Go Rule.** Green appears only on things you can press or on a state that has been confirmed (Selected, Confirmed). Progress indicators, rails and numbered discs are ink, not green; the XP loop's progress is indigo (below).

**The Indigo Is Progress Rule.** Indigo marks the labeler's own progress: XP, the daily goal, streaks, rest days, tiers and stamps. It never colors money (that is gold) or an action (that is green), and an XP figure is never gold. Indigo is the one tinted resting surface allowed, and only on the tier card, the tier-up band, the goal-met toast and the new-stamp strip (Indigo Mist).

**The Tier Ramp.** The four tiers are drawn as numbered discs on the indigo ramp: a reached tier is Indigo Mist (`#e1e0ff`) with Indigo Ink numerals, the current tier is tertiary-container (`#aeb0ff`) with on-tertiary-fixed (`#07006c`) numerals and a white ring outside an indigo gap, and a tier ahead is a hairline ring at 50% white on Progress Indigo (`#494bd6`). The task chip uses the same tertiary-container fill. A held tier is never red: it pauses in indigo and says how to reopen.

**The Gold On Indigo Exception.** On the tier card the line "It opens tasks that pay up to N USDC" sets the amount in secondary-fixed (`#ffdf9b`), Manrope 800. Payout Gold fails contrast on indigo; the gold family still marks it as money, and it is the only gold on an indigo surface.

**The Gold Is Money Rule.** Any amount of USDC is Payout Gold in Manrope. Gold washes are one-shot highlights that fade to paper; gold is never a resting surface.

**The Existing Token Rule.** No color outside the `@theme` block. Tints are made by opacity on an existing token.

## Typography

**Display Font:** Manrope (with ui-sans-serif, system-ui)
**Body Font:** Inter (with ui-sans-serif, system-ui)
**Label/Mono Font:** Inter for labels; the system monospace stack for hashes and addresses only
**Icon Font:** Material Symbols Outlined (incumbent, brand.md §6, loaded globally in the root layout), set by ligature name

**Character:** Manrope at 800 with tight negative tracking carries headlines and every number, so amounts read like a printed total. Inter keeps body and field text quiet and legible at small sizes on phones.

### Hierarchy
- **Display** (800, line-height 0.95, -0.04em; tokens `display`, `display-sm`, `display-lg`, `display-xl` are its breakpoint steps, not separate roles): the two-line hero only. Each line rises into its own clip on load. Responsive steps: 3.25rem base, 5rem at sm (640px), 4.5rem at lg (1024px, where the hero splits into two columns), 5.25rem at xl (1280px).
- **Headline** (800, line-height 1.05, -0.03em): section headings. Responsive steps: 1.875rem base, 2.75rem at sm. The closing stub's heading is the narrower step of the same role: 1.875rem base, 2.5rem at sm. (token `headline-stub`).
- **Title** (700, 1.25rem, 1.5rem from sm): journey line titles.
- **Amount** (800, 1.875rem on stubs, tracking-tighter, tabular numerals): every total, with its unit beside it at 700 and a smaller size.
- **Body** (400, 1rem to 1.25rem, line-height 1.625): sublines and section intros held to about 30rem / 34 to 46ch.
- **Label** (600 or 700, 0.875rem): buttons, nav, receipt row names and values on stubs and the journey.
- **Micro-label** (700, 11px, 0.2em tracking, uppercase, outline color): field names on stubs and journey panels (Paid, Prompt, Reason) and the footer domain. Never above a section heading.
- **Mono** (400, 11px to 12px): wallet addresses, tx hashes, the footer build SHA.
- **In-app progress steps** (#201–#203, from the gamification boards): 10px (pills: New, the task chip and board tier pills at 11px), 13px (secondary lines on the week, tier and hold cards, the board's notes and the event-code card), 15px (Home's Progress rows, board names and XP), 20px (the XP figure on the tier card, the Progress heading), 26px / 28px (the tier name on Home / Progress, the board's week heading) and 56px (the tier name on the tier-up band). They belong to the in-app cards only, never the landing.
- **Phone screen** (exempt): the hero phone's screen is the app's own task and success screens, set in the app's own sizes at 360 by 760 CSS pixels and scaled to the frame (about 0.68 on phones, 0.77 at 1024px, 0.82 at 1280px). Its text is not part of this page's scale and follows TaskCard and app/page.tsx, not this file.
- **Icon** (Material Symbols Outlined, weight 400, line-height 1, one em square, ligature names): every icon. Filled (`FILL 1`) for emphasized states (verified, the coin, the success check); outlined otherwise. Icons take their text color and never carry meaning alone. Size scale, by context:
  - 14px: reserved (the journey's money line uses 15px).
  - 15px: Confirmed on stubs and journey rows.
  - 16px: caption replay, stub View arrow, link-out marks.
  - 18px: the header Docs pill.
  - 22px: the primary button and the FAQ chevron (token `icon-button`).
  - 26px: journey line titles (token `icon-title`; the base `icon` token is the 16px default).

### Named Rules
**The Numerals Are Manrope Rule.** Amounts, counts in discs, and the signature tally use Manrope or tabular numerals; never Inter for a cUSD / USDC figure.

**The Icon Scale Rule.** Icons are Material Symbols Outlined only, at one of the seven sizes above (13, 14, 15, 16, 18, 22, 26px); pick by context, not by eye.

**The Mono Is For Machines Rule.** Monospace sets only strings a person would copy and verify: addresses, hashes, the build SHA. Never labels, never prose.

## Layout

A single centered column, max-width 72rem (`max-w-6xl`), with 1.25rem side gutters on phones and 2rem from 640px. Sections breathe at 6rem vertical padding (7rem from 640px; the journey uses 8rem). Full-bleed bands in Band tone alternate with Canvas to separate the feed and the video from the rest.

- **Hero:** stacked on phones; from 1024px a two-column grid of fluid copy and a 30rem phone column (34rem from 1280px), filling the viewport height under the 4.5rem sticky header.
- **Hero phone:** a 360:760 screen in a frame 16.5rem wide on phones, 18rem from 640px, 18.5rem from 1024px and 19.5rem from 1280px. The owl stands at its lower left, in front of the frame (5.5rem on phones, 9rem from 640px, 10rem from 1024px), and the pair is nudged right so the two sit centered together. The sample caption is centered beneath.
- **Payout feed:** a horizontal snap-scroll strip of 15.5rem stubs on phones and tablets, a four-column grid from 1024px.
- **Journey:** stacked on phones; from 1024px a 24rem sticky intro beside the numbered list, which runs on a 2.5rem disc column plus content.
- **Close:** a single stub, max 36rem, centered.

Breakpoints are Tailwind's defaults (640, 768, 1024, 1280). Nothing essential is behind hover; tap targets on buttons are 56px.

## Elevation & Depth

Depth is soft and ambient, from brand.md's cool-ink shadow scale (rgba(25,28,30) at 3 to 10%), plus green-tinted shadows on the primary action. The receipt language adds one technical rule: a masked stub cannot carry a box-shadow (the mask clips it), so stubs take a `drop-shadow` filter on a wrapper, which follows the teeth. The hero phone is the one dense, dark object, with a faint inner highlight on its frame edge.

### Shadow Vocabulary
- **Soft** (`box-shadow: 0 8px 24px rgba(25,28,30,0.06)`): standard content cards such as the FAQ (incumbent).
- **Whisper** (`box-shadow: 0 4px 12px rgba(25,28,30,0.04)`): journey field panels.
- **Device** (`box-shadow: 0 32px 64px -20px rgba(25,28,30,0.38), 0 14px 28px rgba(25,28,30,0.10), inset 0 0 0 1.5px rgba(255,255,255,0.10)`): the hero phone's frame only. It is deeper than the cool-ink scale because the frame is the page's one dark object.
- **Stub** (`filter: drop-shadow(0 8px 18px rgba(25,28,30,0.08))`, hover `drop-shadow(0 16px 28px rgba(25,28,30,0.12))` with a 4px lift): payout stubs.
- **Handed Stub** (`filter: drop-shadow(0 24px 40px rgba(25,28,30,0.09))`): the closing stub.
- **Action** (`box-shadow: 0 8px 24px rgba(0,109,61,0.2)`, hover `0 12px 32px rgba(0,109,61,0.3)`): the primary button (incumbent signature shadow).
- **Video Frame** (`box-shadow: 0 24px 60px rgba(0,109,61,0.14)`): the promo video frame only.
- **Header Hairline** (`box-shadow: 0 1px 0` outline-variant at 55%): appears on the sticky header over the first 96px of scroll, where scroll-driven animation is supported.

### Named Rules
**The Filter Follows The Tear Rule.** Anything cut with a mask takes a drop-shadow filter on its parent, never a box-shadow on itself.

**The No Default Shadow Rule.** Tailwind's `shadow-md` / `shadow-lg` are never used; every shadow is an arbitrary value from the list above.

## Shapes

Two families. The incumbent family is rounded: pills (`full`) for buttons and chips, 1rem to 1.5rem for cards, 2rem for the video frame, and the hero phone's frame at 2.6rem (2.9rem from 1024px) with its screen inset 0.55rem at the matching inner radius (2.05rem, 2.35rem from 1024px). The video frame's 3rem corner is not a resting radius: it is the start frame of its scroll-in animation, which opens from 3rem (and 0.92 scale) to its resting 2rem as the frame enters view, and only where reduced motion is not requested. The receipt family is cut, not rounded: stubs have a row of 14px triangular teeth on both ends, made by a CSS mask so the paper stays one flat white shape. The masks paint nothing: their `#000` is the alpha channel meaning keep, and `#0000` (transparent) means cut. Neither is a color in the palette, and neither may appear as a painted fill, text or border. Inside paper, structure is drawn with lines, not boxes: dashed rules (outline-variant) between groups and dotted leaders between a field name and its value. Empty and error states in the feed use a dashed 1.5rem-radius frame, the same line as the receipt rules.

## Components

### Buttons
Tactile and confident, the incumbent signature button kept as is.
- **Shape:** full pill (9999px), 56px tall, up to 20rem wide.
- **Primary (Connect Freighter):** the green action gradient from Ledger Green to Signal Green, white label at 1.125rem / 700, a Material icon, Action shadow.
- **Hover / Focus:** lifts 2px and deepens the green shadow; press scales to 0.97; focus shows a 2px primary ring offset 2px from the surface.
- **Pill (Docs, header):** flat primary fill, 0.875rem / 700 label with icon, a lighter green shadow (0 4px 12px at 15%), lifts 1px on hover.
- **Inline link:** primary, 600, underline on hover; used for email sign-in, the payout account and contact.

### Cards / Containers
- **Content card (incumbent):** Paper on 1.5rem radius, Soft shadow, used by the FAQ list with 30%-opacity outline-variant dividers.
- **Line-item field panel:** Paper, 0.5rem radius, Whisper shadow, 0.875rem label text, one receipt row per field.

### Navigation
Sticky 4.5rem header on Canvas: wordmark (Manrope 800, tracking-tighter, primary) with the logo on the left, section links (0.875rem / 600, on-surface-variant) from 768px with a primary underline that grows from the left on hover, the Docs pill on the right. The hairline under it appears only once the page scrolls. Phones show wordmark and Docs only.

### Phone (signature)
The hero. A handset in the Device shadow (dark frame, side keys, camera island, status bar at 9:41, home indicator) whose screen runs a miniature of the real task screen: the app header with wallet chip and earnings badge, then TaskCard's Label Task row, prompt card and both response cards. It plays one sample task with no visitor input. The task opens at the top; a fingertip (a translucent dot that lands, presses to 0.82 and lifts, 520ms) taps the better response, which takes a primary ring and a Selected chip that pops in; the reason card mounts and the sticky Submit & Get Paid bar slides up (500ms); the screen scrolls down to the reason (a 1000ms flick on the brand ease-out, with a scroll indicator that shows only while it moves); the reason types itself at 32ms per character with a primary caret, Submit enables at 10 characters, is tapped, and shows pulsing dots. The app's success screen then fades in ("+0.05 USDC on its way", the check popping in), Next Task is tapped, and the next seeded sample opens at the top while the success screen fades out over it; the earnings badge has gone up by one reward and pops. The owl changes pose per stage (wave, think, idea, laptop, chart) with a 500ms scale settle. Playback runs only while on screen in a visible tab; a light pointer tilt applies on fine pointers. A caption with a replay icon names it a sample on testnet. Reduced motion shows the answered task, scrolled to the reason with Submit enabled, still.

### Payout Stub
A payout as a stub torn at both ends: a Paid micro-label with a relative time, the amount in gold Manrope 800, To and Tx rows with dotted leaders to mono values, then a dashed rule over Confirmed (green, filled verified icon) and a View affordance whose arrow nudges up-right on hover. The whole stub is a link to the ledger. A stub the feed has not shown before slides in from the left (700ms) with a gold wash that fades over 1.8s; reduced motion shows it in place with no wash.

### Line Item (journey)
A numbered sequence on an ink rail. Each line: a 40px disc (ink with a Canvas numeral when reached, Paper with a ring when not), a title with a Material icon (gold on the money line, muted otherwise), a short body, and a field panel of receipt rows. As a line crosses mid-screen the rail fills to it (700ms), its text goes from 40% to full opacity, and its panel stamps in left to right in 14 steps. Only the final Status row is green. Without scripts or with reduced motion every line reads as reached.

### Closing Stub
The last stub, torn at both ends: wordmark over a dashed rule, headline, body, a dashed rule, then the wallet sign-in again (without the phone pairing prompt).

### Accepted Stub (in app, #201)
The success screen's receipt, behind the gamification flag: an Answer accepted micro-label with the date and time, then Reward (gold), Payout (Pending) and XP rows on dotted leaders. The Daily goal and streak-milestone rows appear only when they happened. A dashed rule sits over "Toward Trusted 1,015 / 1,500 XP" while the next tier is ahead (#202), or Total XP once it is reached, and an earned rest day adds one more dashed rule and a `bedtime` line. Every XP value is indigo. It is cut with the stub mask, so its drop-shadow sits on the wrapper. Above it, the check shrinks to 88px and the heading's amount turns gold. A passed quality check shows a single XP row on a Whisper field panel instead.

### Tier Card (Home and Progress, #202)
Replaces #201's XP card, behind the flag (board 03). Progress Indigo fill and the same indigo shadow. A Tier micro-label over the tier name (Manrope 800, 26px; 28px on Progress), the four tier discs at 22px on the right, then the XP total over the next tier's threshold ("1,500 for Trusted") and an 8px bar in white on 20% white. Under it: "N XP to Trusted. It opens tasks that pay up to 1.45 USDC.", the ceiling the live pool pays in that band. Expert drops the bar. On Progress (board 07) the owl sits in a 60px Indigo Mist disc beside the name, the threshold reads "N to Trusted", and a dashed rule in 40% white leads to receipt rows in Indigo Mist and white: Quality checks, Matched the crowd, Answers, Streak ("None yet" until there is history).

### Hold Card (#202)
Board 09. A Paper card under the tier card while a tier is on hold, as a status, never an alert: a `pause_circle` in indigo beside "Trusted tasks paused", a line naming the signal that dropped and that the next 3 checks reopen it, then three 28px discs that fill indigo with a check as checks pass.

### Tier-up Screen (#202)
Board 06, shown once after the answer that opened a tier, before the next task. An indigo band with a 40px bottom radius holds the owl (116px), the tier name in Manrope 800 at 56px, "You've reached tier 2 of 4." and a four-step rail (32px discs, names under them, a 2px track filled white to the current tier). A receipt stub overlaps the band by 40px: Now open to you, then New tasks, Difficulty, They pay (gold), XP per answer (indigo), a dashed rule and Keep it open. Its drop-shadow is indigo-tinted (0 14px 24px at 16% of `#07006c`). The authored moment: the owl settles in from 0.82 and the stub prints down with a clip-path over 900ms, both on the brand ease-out; reduced motion shows them in place. See New Tasks (primary) and Back to home (inline link) close it.

### Stamps (Progress, #202)
Fourteen 72px stamps in a three-column grid, earned first. An earned stamp is a 2.5px indigo ring around a dashed inner ring on Indigo Mist with an Indigo Ink icon, tilted a few degrees as if pressed by hand (the tilt is fixed per position); one earned today is filled indigo with a dashed white ring, a soft indigo shadow and a New pill. A locked stamp is a dashed Rule Line ring with a Pencil icon. Under each: the title (700 earned, 600 locked) and the date earned, or the progress ("53 / 250", "Matched 18 / 25", "4 / 6 topics"). #203: each event code's own stamp joins the grid in its icon and title, captioned "Event · 10 Oct"; the Event slot stays locked ("Event code") for the next event, so the count grows ("7 of 15"). The locked Top 3 reads "Best: #6" once the labeler has finished a week. The two invite stamps, Invited in (`waving_hand`) and Brought a friend (`group_add`), read "Joined by invite" and "Invite a friend" while locked. The success stub links a new stamp through an Indigo Mist strip with a tilted indigo disc and "See your new stamp".

### Progress Tabs (#203)
Boards 07 and 08. A pill tab bar on Skeleton (surface-container-high), 4px inset, two 44px tabs: the selected one is Paper with a faint shadow and 700 ink, the other 600 Ink Muted. Stamps carries its count in indigo ("1 of 13"). On Stamps it sits under the tier card; on This week the tier card steps aside and the bar sits under the header.

### Weekly Board (Progress → This week, #203)
Board 08. "Week of 12 Oct" in Manila 800 at 26px with "Ends Sun 18 Oct, 11:59 PM PHT." under it, and an Indigo Mist pill for the days left. Then a Paper list of 54px rows: a 28px rank disc (filled indigo for the top 3, a Rule Line ring after), the name (or "Hidden labeler" in Ink Muted) over a tier pill on the indigo ramp (Starter Indigo Mist, Skilled tertiary-container, Trusted indigo, Expert Indigo Ink), a dotted leader and the XP in indigo Manrope 800. Your row is a 58px indigo slab with an inverted disc and "· You"; when you're below the top 20 it follows three Rule Line dots. A labeler under the weekly floor sees why in Indigo Mist, never red. Under the list: "How the board works" on Indigo Mist, then the Show my name card (Paper, a 52×32 switch in primary when on, "Edit name" as an inline link, and an inline name form under a dashed rule). An admin hide puts an Indigo Mist note above it and opens the form.

### Event Code Card (Progress → Stamps, #203)
Board 07. At the foot of Stamps on Indigo Mist, 24px radius: "Event code" in Indigo Ink, the booth line in on-tertiary-fixed-variant, a white 48px field (uppercase, placeholder "e.g. BQF2026") and a primary Add pill. A code from a booth link arrives filled and focused, with "From your link. Tap Add to collect it." Outcomes speak in the same indigo text: added (with the stamp's icon), already added, closed, not open yet, too many tries.

### Weekly Quests (Progress → This week, #203)
No board; drawn in the receipt language. A Paper card (Soft shadow, 1rem radius) between the week heading and the board: "This week's quests" (Manrope 700, 15px) over "30 XP each. They start over on Monday." in 13px Ink Muted, a dashed rule, then one receipt row per quest: its icon, the title (0.875rem), a dotted leader and the progress ("3 / 5") in indigo Manrope 800. A finished quest turns its icon and title to ink and its value to a filled indigo `check_circle` and "+30 XP". The success stub adds a row per quest the answer finished, titled by the quest, its +30 in indigo.
### Invite Card (Progress → Stamps, #203)
No board. A Paper card under the Event code card, 1.5rem radius, Soft shadow: a 40px Indigo Mist disc with a dashed indigo ring and `group_add`, tilted like a stamp, beside "Invite a friend" and "You both get 50 XP and a stamp when they reach Skilled." Under it the whole link on a Band (surface-container-low) field (centred, 600, selectable, no scheme so the code always shows at 375px), then a full-width primary Share pill: the phone's share sheet, or the clipboard with the label turning to a check and "Copied". A dashed rule leads to one receipt row, "Friends qualified · 2 of 10", in indigo. At the cap a 13px line says friends still get their 50 XP and stamp.
### Home Board Row (#203)
Board 03. Home's progress card gains a second row under Progress and stamps, split by an inset hairline: `leaderboard` on Indigo Mist, "This week's board" and "You're #6" (or "Not placed yet", "Not on it yet").

### Admin Gamification (#203)
Board 10, a super-admin tab shown whatever the flag says. Three cards in the admin console's own style: Event codes (a New code form inline, not a modal: code, stamp name, an icon radio row of 44px discs, first and last Manila day; then a hairline table of code in mono, stamp with its icon, days "15–16 Oct", and Redeemed or "Not started"), Weekly board (#, name or Hidden labeler, tier pill, XP, and Hide name, which asks "Hide migs.dela?" in error red before it acts, since a hidden name is retired for good), and read-only XP rules.

### Task Chip (#202)
Board 04. On a task above Starter, the prompt card's header carries a pill on tertiary-container with on-tertiary-fixed text: `lock_open` and "Skilled task" (or the task band's tier). It reads from difficulty alone, so a quality check shows the same as any task.

### Admin Crowd (#202)
Board 10. On a campaign, behind the flag: a Crowd card in the admin console's own card style, a radiogroup of Everyone, Skilled and up, Trusted and up (the chosen one filled primary) and a dashed, disabled "Expert only · later", then a table of hairline rows: labelers who qualify now (live), the CSV's optional difficulty column, tasks with no difficulty open to every tier, and the export's labeler_tier column.

### XP and Week Cards (Home, #201)
After Total earned, behind the flag:
- **XP card:** replaced by the tier card in #202 (above).
- **Week card:** a Paper card with seven 36px discs, Monday to Sunday in Manila time. A met day is filled indigo with a check. Today has an indigo ring on Indigo Mist and reads "n/5". A rest day has a dashed indigo ring and a `bedtime` icon. Protected, missed and future days are a Rule Line ring.
- **Under the discs:** a five-bar tally and a line saying what today decides. An ended streak replaces that line with a plain statement, never in error red.

Start Earning then comes before the FAQ, and a third ambient blob in indigo joins the green and gold ones. On the task screen, a today strip of five 4px indigo segments sits in the header's Band, and the reward pill gains a hairline and "+N XP".

## Do's and Don'ts

### Do:
- **Do** use only tokens from the `@theme` block; make tints with opacity on an existing token.
- **Do** set every amount in Payout Gold, Manrope 800, tabular numerals, with the unit beside it.
- **Do** keep green to presses and confirmations; draw progress, rails and step discs in ink.
- **Do** build receipt rows as field name, dotted leader (outline-variant), value; separate groups with dashed rules.
- **Do** cut torn edges with the stub mask (14px teeth) and shadow them with a drop-shadow filter on the parent.
- **Do** ease motion with cubic-bezier(0.16, 1, 0.3, 1) and give every animation a finished still frame under reduced motion.
- **Do** put any fade that hides clipped content outside the clipped element, so no row leaks at fractional edges.
- **Do** name sample data as a sample, and say testnet plainly wherever payouts appear.

### Don't:
- **Don't** use monospace for anything but addresses, hashes and the build SHA.
- **Don't** put a micro-label above a section heading; micro-labels name fields inside paper.
- **Don't** give a masked stub a box-shadow; it is clipped by the mask.
- **Don't** use Tailwind's default shadows, pure black, or colors outside the palette.
- **Don't** draw solid outline borders around content cards; the only lines are the receipt's dashed rules and dotted leaders, and hairline dividers.
- **Don't** make gold a resting surface; gold washes flash once and fade.
- **Don't** apply the receipt language to the task screen or admin console by assumption; they have not been redesigned. The hero phone mirrors the task and success screens as shipped with the gamification flag off; when they change, update its miniature to match rather than restyling it.
- **Don't** put an XP figure in gold or a USDC amount in indigo; XP is never money (ADR-0010).

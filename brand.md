# BRAND.md — Centient

The visual and voice system for Centient. This document is the single source of truth when the coding agent builds UI. Extracted from the approved mockups (`landing`, `success`, `labeling-task`).

---

## 1. Identity

- **Name:** Centient
- **Wordmark:** lowercase-proof — always render as "Centient" (capital C, rest lowercase). Never all-caps, never "centient".
- **Tagline:** *Train AI, cent by cent.*
- **Domain:** `centient.work`
- **One-line pitch:** "Label training data and get paid instantly in cUSD. Turn your precision into tangible value."
- **Origin story (for copy moments):** "The cent in sentient."

### Voice

- **Clear, not clever.** No wordplay in core UI labels. Wordplay allowed in marketing / hero moments only (e.g. the tagline).
- **Direct & action-first.** Buttons start with verbs: *Start Labeling*, *Submit & Get Paid*, *Next Task*. Never *Click here* or *Continue*.
- **Confident, not hypey.** Say "Paid 0.05 cUSD ✓" not "🎉 YOU EARNED 0.05 cUSD! 🎉".
- **No crypto jargon by default.** Say *wallet* not *address*, *paid* not *settled*, *task* not *job*. "cUSD" is OK because it's visible in MiniPay already.
- **No AI jargon in user-facing copy.** Avoid *annotation*, *inference*, *preference pair*, *RLHF*. Say *task*, *choice*, *reason*.
- **Never lecture the user.** If quality check fails, don't explain gold-task methodology. Just: "Quality check failed — try another task."

---

## 2. Design token install (Tailwind 4)

The mockups use a Material-3-derived token set. Install in `app/globals.css` as a Tailwind 4 `@theme` block. Every color below is a named token — the agent MUST use token names (`bg-primary`, `text-on-surface-variant`) and NOT hardcoded hex in components.

```css
/* app/globals.css */
@import "tailwindcss";

@theme {
  /* Primary — Celo-adjacent deep green */
  --color-primary: #006d3d;
  --color-on-primary: #ffffff;
  --color-primary-container: #35d07f;
  --color-on-primary-container: #00542d;
  --color-primary-fixed: #6bfda7;
  --color-primary-fixed-dim: #4ae08d;
  --color-on-primary-fixed: #00210f;
  --color-on-primary-fixed-variant: #00522c;
  --color-inverse-primary: #4ae08d;

  /* Secondary — warm gold (the "cent" / payout color) */
  --color-secondary: #785a00;
  --color-on-secondary: #ffffff;
  --color-secondary-container: #fdce5e;
  --color-on-secondary-container: #745700;
  --color-secondary-fixed: #ffdf9b;
  --color-secondary-fixed-dim: #eec052;
  --color-on-secondary-fixed: #251a00;
  --color-on-secondary-fixed-variant: #5a4300;

  /* Tertiary — indigo (reserved, not used in v1 core flows) */
  --color-tertiary: #494bd6;
  --color-on-tertiary: #ffffff;
  --color-tertiary-container: #aeb0ff;
  --color-on-tertiary-container: #302fbf;
  --color-tertiary-fixed: #e1e0ff;
  --color-tertiary-fixed-dim: #c0c1ff;
  --color-on-tertiary-fixed: #07006c;
  --color-on-tertiary-fixed-variant: #2f2ebe;

  /* Error */
  --color-error: #ba1a1a;
  --color-on-error: #ffffff;
  --color-error-container: #ffdad6;
  --color-on-error-container: #93000a;

  /* Surface — off-white background, white cards */
  --color-background: #f8f9fb;
  --color-on-background: #191c1e;
  --color-surface: #f8f9fb;
  --color-surface-bright: #f8f9fb;
  --color-surface-dim: #d9dadc;
  --color-surface-container-lowest: #ffffff;
  --color-surface-container-low: #f3f4f6;
  --color-surface-container: #edeef0;
  --color-surface-container-high: #e7e8ea;
  --color-surface-container-highest: #e1e2e4;
  --color-surface-variant: #e1e2e4;
  --color-surface-tint: #006d3d;
  --color-on-surface: #191c1e;
  --color-on-surface-variant: #3d4a3f;
  --color-inverse-surface: #2e3132;
  --color-inverse-on-surface: #f0f1f3;

  /* Outline */
  --color-outline: #6c7b6e;
  --color-outline-variant: #bbcabc;

  /* Typography */
  --font-headline: "Manrope", ui-sans-serif, system-ui, sans-serif;
  --font-body: "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-label: "Inter", ui-sans-serif, system-ui, sans-serif;

  /* Radii (Material 3 shape scale, slightly sharper than default) */
  --radius-sm: 0.25rem;      /* 4px — chips, input accents */
  --radius-md: 0.5rem;       /* 8px — small buttons */
  --radius-lg: 0.75rem;      /* 12px — inputs */
  --radius-xl: 1rem;         /* 16px — cards */
  --radius-2xl: 1.5rem;      /* 24px — featured cards */
  --radius-3xl: 2rem;        /* 32px — primary content cards */
  --radius-full: 9999px;     /* pills, CTA buttons */
}
```

Fonts loaded in `app/layout.tsx`:

```ts
import { Manrope, Inter } from "next/font/google";

const manrope = Manrope({ subsets: ["latin"], weight: ["400","500","600","700","800"], variable: "--font-headline" });
const inter = Inter({ subsets: ["latin"], weight: ["400","500","600","700"], variable: "--font-body" });
```

Apply `${manrope.variable} ${inter.variable}` on `<html>`.

---

## 3. Color usage rules

| Role | Token | Use |
|---|---|---|
| Brand | `primary` (#006d3d) | Logo wordmark, primary buttons (as gradient start), accent text, focus rings. |
| Action gradient end | `primary-container` (#35d07f) | Always paired as `bg-gradient-to-br from-primary to-primary-container` for CTAs. |
| Money | `secondary` (#785a00) | Earnings amounts, payout badges, "cUSD" unit text. ALWAYS use for financial numbers. |
| Money surface | `secondary-container` / `secondary-fixed-dim` | Pill backgrounds for earnings badges. |
| Success | `primary` family | Checkmarks, confirmation states. Don't introduce a separate green. |
| Error | `error` / `error-container` | Bans, failed submissions, validation errors. |
| Canvas | `surface` (#f8f9fb) | Page background. |
| Cards | `surface-container-lowest` (#ffffff) | All content cards. |
| Subtle surfaces | `surface-container-low` → `surface-container-highest` | Pills, chips, pressed states, inset areas. |
| Body text | `on-surface` (#191c1e) | Primary reading text. |
| Secondary text | `on-surface-variant` (#3d4a3f) | Metadata, helper text, descriptions. |
| Micro-labels | `outline` (#6c7b6e) | Overline labels, uppercase tags. |

**Never use:** pure black, pure white for text on white, or introduce ad-hoc colors outside this palette. If you think you need a new color, you don't — reach for an existing token.

---

## 4. Typography

Two families, three roles:

| Role | Font | Weights | Used for |
|---|---|---|---|
| Headline | Manrope | 700 / 800 | Logo, page titles, hero text, numeric amounts, section H1–H3. |
| Body | Inter | 400 | Paragraphs, response text, descriptions. |
| Label | Inter | 500 / 600 / 700 | Buttons, form labels, chips, uppercase overlines, input copy. |

### Scale (Tailwind classes)

```
Hero H1         text-[2.5rem] font-headline font-extrabold tracking-tight leading-[1.1]
Page H1         text-3xl md:text-4xl font-headline font-extrabold tracking-tight
Section H1      text-2xl font-headline font-bold
Section H2      text-sm font-headline font-bold uppercase tracking-wide  (overline)
Card H3         text-lg font-headline font-bold
Body            text-base font-body leading-relaxed
Body small      text-sm font-body leading-relaxed
Micro-label     text-xs font-label font-bold uppercase tracking-[0.2em]
Button          text-lg font-label font-bold  (primary)
                text-sm font-label font-semibold  (secondary / tertiary)
Amount (big)    text-4xl md:text-5xl font-headline font-extrabold tracking-tighter
Amount (small)  text-xl font-headline font-bold
```

### Typography rules

- **Numeric amounts always use Manrope.** Never render cUSD amounts in Inter.
- **The wordmark "Centient" uses `tracking-tighter`**, weight 800, `text-primary`. Never italic, never letter-spaced out.
- **Overline labels** (small uppercase text like "UPDATED BALANCE", "BATCH #4092", "CUSD READY") use `text-[11px]` or `text-xs`, `font-label font-bold uppercase`, and `tracking-[0.2em]` or `tracking-widest`.
- **Gradient text accent** (hero moment only): `text-transparent bg-clip-text bg-gradient-to-r from-primary to-secondary`. Use once per screen maximum.

---

## 5. Shape & elevation

### Radii — what gets what

| Element | Radius |
|---|---|
| Chips, inline tags | `rounded-full` |
| Inputs, textareas | `rounded-lg` (0.5rem) |
| Small buttons, secondary CTAs | `rounded-xl` (0.75rem) or `rounded-2xl` (1rem) |
| Cards (standard) | `rounded-xl` (0.75rem) or `rounded-2xl` (1rem) |
| Featured cards | `rounded-3xl` (1.5rem → 2rem) |
| Primary CTA | `rounded-full` or `rounded-2xl` |
| Hero container | `rounded-t-[2.5rem] rounded-b-xl` (asymmetric) |

### Shadows — the 5-tier scale

Drop these in as Tailwind arbitrary values. Never use Tailwind's default `shadow-md` / `shadow-lg`; they're too harsh for this brand.

```
Whisper    shadow-[0_4px_12px_rgba(25,28,30,0.03)]          pills, inline chips
Soft       shadow-[0_8px_24px_rgba(25,28,30,0.06)]          standard cards
Float      shadow-[0_8px_32px_rgba(25,28,30,0.08)]          glassmorphic overlays
Lift       shadow-[0_12px_40px_rgba(25,28,30,0.06)]         featured cards (also works flipped: 0_-12px_40px_... for cards rising from bottom)
Hero       shadow-[0_24px_48px_rgba(25,28,30,0.04)]         full-bleed hero containers
```

### Signature shadow (primary CTAs only)

Colored shadow in primary green — what makes the Start Labeling / Submit button feel alive:

```
Rest:  shadow-[0_8px_24px_rgba(0,109,61,0.2)]
Hover: shadow-[0_12px_32px_rgba(0,109,61,0.3)]
Halo:  shadow-[0_12px_40px_-12px_rgba(0,109,61,0.5)]   (success state, large icons)
```

---

## 6. Iconography

- **Library:** Material Symbols Outlined (already linked via Google Fonts in mockups). Load once globally in `layout.tsx`.
- **Variation axis:** use `FILL 1` for active / emphasized icons (primary CTA arrows, wallet icons in the header). Use unfilled for inline helpers.
- **Sizing:** `text-[16px]` inside chips, `text-[20px]`–`text-[22px]` in buttons, `text-[28px]`–`text-[32px]` for card icons, 48–64px for hero confirmation icons.
- **Color:** icons inherit text color. Primary icons → `text-primary`. Money icons → `text-secondary`. Never fill icons with tertiary or error unless semantically required.

### Core icon vocabulary

| Icon | Use |
|---|---|
| `account_balance_wallet` | Wallet / balance references |
| `payments` | "cUSD Ready" trust chip |
| `monetization_on` | Reward amount next to "0.05 cUSD" |
| `dataset` | Task batch indicator |
| `chat` | "The Prompt" header |
| `check` | Success confirmation |
| `arrow_forward` | CTA button, "next" affordance |

Don't introduce new icons per screen unless the concept is genuinely new. Reuse aggressively.

---

## 7. Component patterns

### 7.1 Top app bar

```tsx
<header className="bg-surface-container-low sticky top-0 z-40 flex w-full items-center justify-between px-6 py-4">
  <div className="flex items-center gap-3">
    <span className="material-symbols-outlined text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>
      account_balance_wallet
    </span>
    <span className="text-xl font-headline font-extrabold text-primary tracking-tighter">Centient</span>
  </div>
  <span className="rounded-full bg-secondary-fixed/20 px-3 py-1 text-sm font-semibold text-secondary">
    $12.50
  </span>
</header>
```

### 7.2 Primary CTA (the signature button)

Every "go" button in the app uses this. Gradient fill + colored shadow + active scale.

```tsx
<button className="flex h-16 w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-primary to-primary-container font-label text-lg font-bold text-white shadow-[0_8px_24px_rgba(0,109,61,0.2)] transition-transform duration-200 active:scale-[0.97]">
  Start Labeling
  <span className="material-symbols-outlined text-[22px]">arrow_forward</span>
</button>
```

- **Height:** 56–64px (h-14 to h-16) on mobile, 52–56px on desktop.
- **Always** gradient, never flat primary.
- **Always** includes the `arrow_forward` icon when it leads forward.
- **Active state:** `active:scale-[0.97]` only — no color change.

### 7.3 Secondary / tertiary actions

```tsx
<button className="w-full rounded-xl bg-transparent px-6 py-3 font-label text-sm font-semibold text-outline transition-colors hover:bg-surface-container-low">
  Return to Dashboard
</button>
```

Flat, text-only, uses `outline` color for the label. Never competes with the primary CTA.

### 7.4 Content card (the workhorse)

```tsx
<section className="rounded-2xl bg-surface-container-lowest p-6 shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
  ...
</section>
```

That's the default card. Use it for prompts, responses, inputs, balance displays. Padding scales with importance: `p-6` default, `p-8` for hero cards.

### 7.5 Earnings pill (money chip)

```tsx
<div className="flex items-center gap-2 rounded-xl bg-surface-container-lowest px-4 py-2 shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
  <span className="material-symbols-outlined text-sm text-secondary" style={{ fontVariationSettings: "'FILL' 1" }}>
    monetization_on
  </span>
  <span className="font-headline text-sm font-bold text-secondary">0.05 cUSD</span>
</div>
```

### 7.6 Trust chip (status indicator)

```tsx
<div className="flex items-center gap-1.5 rounded-full bg-surface-container-high px-3 py-1.5 shadow-[0_4px_12px_rgba(25,28,30,0.03)]">
  <span className="material-symbols-outlined text-[16px] text-secondary" style={{ fontVariationSettings: "'FILL' 1" }}>
    payments
  </span>
  <span className="text-xs font-label font-bold tracking-wide text-on-surface-variant">cUSD Ready</span>
</div>
```

### 7.7 Reason textarea

```tsx
<section className="rounded-2xl bg-surface-container-lowest p-6 shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
  <label className="mb-2 block font-headline text-sm font-bold text-on-surface">
    Why? <span className="text-xs font-normal text-outline">(min 10 characters)</span>
  </label>
  <textarea
    rows={3}
    placeholder="Explain your reasoning for selecting the better response..."
    className="w-full resize-none rounded-lg border-none bg-surface-container-highest px-4 py-3 font-body text-sm text-on-surface placeholder-on-surface-variant/50 focus:ring-0"
  />
</section>
```

### 7.8 Balance display (success moment)

```tsx
<div className="relative mb-12 w-full overflow-hidden rounded-3xl bg-surface-container-lowest p-6 shadow-[0_8px_32px_rgba(25,28,30,0.06)]">
  <div className="relative z-10 flex flex-col items-center">
    <span className="mb-2 font-label text-xs font-bold uppercase tracking-widest text-outline">Updated Balance</span>
    <div className="flex items-baseline gap-1">
      <span className="font-headline text-4xl md:text-5xl font-extrabold tracking-tighter text-on-surface">12.55</span>
      <span className="font-headline text-xl font-bold text-secondary">cUSD</span>
    </div>
  </div>
</div>
```

### 7.9 Ambient background (landing & success)

Two blurred radial blobs for atmosphere. Non-interactive, always behind content.

```tsx
<div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
  <div className="absolute -top-[20%] -right-[10%] h-[80vw] w-[80vw] rounded-full bg-primary/5 blur-[100px]" />
  <div className="absolute top-[40%] -left-[20%] h-[70vw] w-[70vw] rounded-full bg-secondary/5 blur-[80px]" />
</div>
```

Use on marketing / success screens. Skip on task screens — they should feel focused, not atmospheric.

---

## 8. Screen templates

### 8.1 Landing / open-in-MiniPay screen

- Full-bleed canvas, ambient background on.
- Header: wordmark left, "cUSD Ready" trust chip right.
- Hero image area with overlapping rounded container (asymmetric: `rounded-t-[2.5rem] rounded-b-xl`).
- Glassmorphic floating indicator on hero image (batch/status).
- Primary content card rising from bottom (`rounded-[2rem]` top).
- Hero H1 with gradient accent on one line (`bg-clip-text` trick).
- Single primary CTA.
- Domain anchor at very bottom: `centient.work` in overline micro-label style.

### 8.2 Labeling task screen

- Sticky top app bar with wordmark + balance pill.
- Scrollable content: task header → prompt card → two response cards (bento grid, stack on mobile) → reason textarea.
- Floating submit button fixed at bottom on mobile with gradient-fade background.
- Response cards: identical structure; selected state = `ring-2 ring-primary` + slight scale + filled "Selected A/B" state on button.
- Reward badge top-right shows task reward ("0.05 cUSD").

### 8.3 Success / payout screen

- Centered single-column layout.
- Ambient background on, centered around success icon.
- Large circular icon (128px) with gradient fill + halo shadow, brief bounce animation on mount.
- Confirmation heading + body copy with bolded amount.
- Balance card below.
- Primary CTA: "Next Task". Secondary: "Return to Dashboard".

### 8.4 Quality check failed

Same layout family as success, but:
- Icon: `error_outline` in `error-container` circle (not gradient).
- No balance card.
- Headline: "Quality check failed".
- Body: "Try another task."
- Only primary CTA: "Next Task". No explanation of gold tasks.

### 8.5 Banned state

- Icon: `block` in `error-container`.
- Headline: "Account paused".
- Body: "We noticed unusually low accuracy on recent tasks. Reach out if you think this is a mistake."
- No CTA except a mailto link in plain text.

---

## 9. Motion & interaction

- **Press feedback on all buttons:** `active:scale-[0.97]` or `active:scale-[0.98]`, `transition-transform duration-200`. No color-change on press.
- **Hover on desktop:** lift shadow (`hover:shadow-[0_12px_32px_rgba(0,109,61,0.3)]`) on primary CTAs only. Secondary buttons: subtle bg change.
- **Loading state:** single animated dot-trio in `primary` on button text position. No full-screen spinners.
- **Success bounce:** the checkmark icon on success screen uses `animate-[bounce_1s_ease-in-out_1]` — runs once, then rests.
- **Page transitions:** none in v1. Native MiniPay nav only.
- **Respect `prefers-reduced-motion`:** wrap any decorative motion in `motion-safe:`.

---

## 10. What to avoid

- **No emojis** in UI copy (they read as noisy next to Material icons). Emoji OK in marketing/social off-product.
- **No gradients on non-CTA surfaces.** Cards are always solid `surface-container-lowest`. The primary gradient is reserved for action buttons and the hero accent text.
- **No borders on cards.** Cards rely on shadow, not outline. The only borderish lines are `outline-variant/30` separators inside inputs.
- **No stock "crypto" imagery.** No coins, no chains, no circuit boards. The hero imagery is abstract fluid/organic in brand colors — never literal.
- **No screenshots of other wallets** in marketing. MiniPay only.
- **No dark mode in v1.** The system has dark tokens (`inverse-surface`, etc.) reserved for future, but v1 ships light only. Don't stub a dark toggle.
- **No hard red.** Errors use `error-container` background + `on-error-container` text for the friendlier, pastel feel. Never `bg-red-500`.
- **No Tailwind default shadows** (`shadow-md`, `shadow-lg`). Always the arbitrary-value scale from §5.
- **No uppercase for sentences.** Only micro-labels/overlines.
- **No custom fonts beyond Manrope + Inter.** If a designer asks for a third, push back.

---

## 11. Accessibility floor

- All interactive elements have `focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface`.
- Tap targets ≥ 48×48px (already enforced in mockups).
- Body text contrast: `on-surface` on `surface` → passes AA. Don't reduce body text to `on-surface-variant` for long passages.
- Icons used as the sole meaning carrier get `aria-label`. Decorative icons get `aria-hidden="true"`.
- Buttons never have only an icon without an accessible name.

---

## 12. Asset checklist (pre-launch)

Not required for the one-day MVP but queue these up:

- [ ] Favicon `.ico` + PNG set (16, 32, 192, 512) with "C" mark on primary gradient.
- [ ] Apple touch icon 180×180.
- [ ] `og:image` 1200×630 — wordmark + tagline on brand background.
- [ ] Twitter card 1200×675 — same as og:image variant.
- [ ] MiniPay app icon 512×512 (check MiniPay dev docs for current spec).
- [ ] PWA manifest with primary theme color `#006d3d` and background color `#f8f9fb`.

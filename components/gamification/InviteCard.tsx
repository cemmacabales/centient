"use client";

import { useEffect, useRef, useState } from "react";
import { inviteLink } from "@/lib/gamification/invite-rules";
import type { InviteStanding } from "@/lib/gamification/types";
import { INVITE_NOTE, INVITE_SHARE_TEXT, inviteCapLine, inviteCount, inviteLinkShown } from "./social-format";

const ORIGIN = "https://centient.work";

type Shared = "idle" | "copied" | "manual";

/**
 * #203: the labeler's invite link, under the Event code card. A friend who
 * signs up through it and reaches Skilled pays both of them 50 XP and a stamp.
 * Share opens the phone's share sheet, or copies the link where there is none.
 */
export default function InviteCard({ invite, origin }: { invite: InviteStanding; origin?: string }) {
  const link = inviteLink(invite.code, origin ?? (typeof window === "undefined" ? ORIGIN : window.location.origin));
  const [shared, setShared] = useState<Shared>("idle");
  const field = useRef<HTMLInputElement>(null);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  const capLine = inviteCapLine(invite.qualified, invite.cap);

  useEffect(() => () => {
    if (reset.current) clearTimeout(reset.current);
  }, []);

  async function share() {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "Centient", text: INVITE_SHARE_TEXT, url: link });
        return;
      } catch (err) {
        // Closing the sheet is a choice, not a failure.
        if ((err as { name?: string } | null)?.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(link);
      setShared("copied");
      if (reset.current) clearTimeout(reset.current);
      reset.current = setTimeout(() => setShared("idle"), 2_500);
    } catch {
      // No clipboard either: select the link so it can be copied by hand.
      setShared("manual");
      field.current?.select();
    }
  }

  return (
    <section
      aria-labelledby="invite-heading"
      className="flex flex-col gap-3 rounded-3xl bg-surface-container-lowest p-5 shadow-[0_8px_24px_rgba(25,28,30,0.06)]"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 -rotate-6 items-center justify-center rounded-full border-2 border-dashed border-tertiary/60 bg-tertiary-fixed">
          <span className="material-symbols-outlined text-[22px] text-on-tertiary-fixed-variant" aria-hidden="true">
            group_add
          </span>
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id="invite-heading" className="m-0 font-headline text-base font-bold leading-5 text-on-surface">
            Invite a friend
          </h3>
          <p className="m-0 font-body text-[13px] leading-[18px] text-on-surface-variant">{INVITE_NOTE}</p>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="invite-link" className="sr-only">
          Your invite link
        </label>
        <input
          ref={field}
          id="invite-link"
          type="text"
          readOnly
          value={inviteLinkShown(link)}
          onFocus={(e) => e.currentTarget.select()}
          className="h-12 w-full min-w-0 truncate rounded-xl border-0 bg-surface-container-low px-4 text-center font-body text-sm font-semibold text-on-surface selection:bg-tertiary-fixed focus:outline-none focus-visible:ring-2 focus-visible:ring-tertiary"
        />
        <button
          type="button"
          onClick={() => void share()}
          className="flex h-12 w-full items-center justify-center gap-1.5 rounded-full bg-primary px-5 font-label text-sm font-bold text-on-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface-container-lowest"
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
            {shared === "copied" ? "check" : "share"}
          </span>
          {shared === "copied" ? "Copied" : "Share"}
        </button>
      </div>
      <p
        role="status"
        aria-live="polite"
        className={`m-0 font-body text-[13px] leading-[18px] text-on-surface-variant empty:hidden ${shared === "copied" ? "sr-only" : ""}`}
      >
        {shared === "copied" ? "Link copied." : shared === "manual" ? "Copy the link above to share it." : null}
      </p>
      <div aria-hidden="true" className="border-t-[1.5px] border-dashed border-outline-variant" />
      <div className="flex items-center gap-2 font-body text-sm leading-5">
        <span className="text-on-surface-variant">Friends qualified</span>
        <span aria-hidden="true" className="min-w-3 flex-1 border-b-2 border-dotted border-outline-variant" />
        <span className="shrink-0 font-headline text-[15px] font-extrabold tabular-nums text-tertiary">
          {inviteCount(invite.qualified, invite.cap)}
        </span>
      </div>
      {capLine && <p className="m-0 font-body text-[13px] leading-[18px] text-on-surface-variant">{capLine}</p>}
    </section>
  );
}

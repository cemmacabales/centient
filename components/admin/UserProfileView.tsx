"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { unitsToUsdcDisplay } from "@/lib/stellar/config";
import RetryPayoutButton from "./RetryPayoutButton";

export interface UserProfileProps {
  walletAddress: string;
  createdAt: string;
  totalEarned: string;
  totalEarnedUnits: string;
  submissionCount: number;
  goldCorrect: number;
  goldAttempted: number;
  goldAccuracyPct: number | null;
  isBanned: boolean;
  bannedAt: string | null;
  bannedReason: string | null;
  banCount: number;
  bannedUntil: string | null;
  lastBanAt: string | null;
  country: string | null;
  gender: string | null;
  ageRange: string | null;
  onboardingCompleted: boolean;
  payoutTotals: {
    pending: number;
    sent: number;
    failed: number;
    skipped: number;
    abandoned: number;
  };
  rewardSymbol: string;
  recentSubmissions: Array<{
    id: string;
    taskId: string;
    taskPrompt: string;
    choice: string;
    reason: string;
    isGoldCheck: boolean;
    goldPassed: boolean | null;
    payoutAmountUnits: string;
    payoutStatus: string;
    payoutError?: string | null;
    payoutTxHash: string | null;
    createdAt: string;
  }>;
  reasonRepetition?: {
    hasRepetition: boolean;
    maxDuplicateCount: number;
    mostCommonReason: string | null;
  };
}

export default function UserProfileView({ profile }: { profile: UserProfileProps }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);

  async function handleBanToggle() {
    const action = profile.isBanned ? "unban" : "ban";
    const reason =
      action === "ban" ? prompt("Optional reason for the audit log:", "operator: manual ban") : null;
    if (action === "ban" && reason === null) return;
    try {
      const res = await fetch(`/api/admin/users/${profile.walletAddress}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason: reason || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeedback({ type: "error", text: body.error ?? "Action failed." });
      } else {
        setFeedback({ type: "success", text: action === "ban" ? "User banned." : "User unbanned." });
        startTransition(() => router.refresh());
      }
    } catch (err) {
      setFeedback({ type: "error", text: "Network error." });
    }
  }

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total earned" value={`${profile.totalEarned} ${profile.rewardSymbol}`} />
        <Stat label="Submissions" value={String(profile.submissionCount)} />
        <Stat
          label="Gold accuracy"
          value={
            profile.goldAttempted === 0
              ? "—"
              : `${profile.goldCorrect} / ${profile.goldAttempted} · ${profile.goldAccuracyPct}%`
          }
        />
        <Stat
          label="Status"
          value={profile.isBanned ? "Banned" : "Active"}
          tone={profile.isBanned ? "error" : "ok"}
        />
      </section>

      {profile.reasonRepetition?.hasRepetition && (
        <section className="rounded-2xl border border-amber-300 bg-amber-50 p-5">
          <div className="flex items-center gap-2">
            <span className="font-label text-xs font-bold uppercase tracking-[0.2em] text-amber-700">
              Repetitive reasons
            </span>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 font-label text-[10px] font-bold text-amber-800">
              flagged
            </span>
          </div>
          <p className="mt-2 font-body text-sm text-amber-800">
            {profile.reasonRepetition.maxDuplicateCount} out of the last submissions use the same reason:
          </p>
          {profile.reasonRepetition.mostCommonReason && (
            <p className="mt-1 rounded-lg bg-amber-100/60 px-3 py-2 font-mono text-xs text-amber-900">
              &ldquo;{profile.reasonRepetition.mostCommonReason}&rdquo;
            </p>
          )}
        </section>
      )}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Panel title="Demographics">
          <DefinitionList
            rows={[
              ["Country", profile.country],
              ["Gender", profile.gender],
              ["Age range", profile.ageRange],
              [
                "Onboarding",
                profile.onboardingCompleted ? "Completed" : "Not completed",
              ],
              ["Joined", new Date(profile.createdAt).toLocaleString("en-US")],
            ]}
          />
        </Panel>
        <Panel title="Ban state">
          {profile.isBanned ? (
            <DefinitionList
              rows={[
                ["Ban count", String(profile.banCount)],
                ["Banned at", profile.bannedAt ? new Date(profile.bannedAt).toLocaleString("en-US") : "—"],
                ["Banned until", profile.bannedUntil ? new Date(profile.bannedUntil).toLocaleString("en-US") : "permanent"],
                ["Last ban at", profile.lastBanAt ? new Date(profile.lastBanAt).toLocaleString("en-US") : "—"],
                ["Reason", profile.bannedReason ?? "—"],
              ]}
            />
          ) : (
            <p className="font-body text-sm text-on-surface-variant">
              This user is in good standing. No ban record.
            </p>
          )}
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={handleBanToggle}
              disabled={pending}
              className={`rounded-full px-4 py-2 font-label text-sm font-bold transition-opacity disabled:opacity-50 ${
                profile.isBanned
                  ? "bg-primary text-on-primary hover:opacity-80"
                  : "bg-error-container text-on-error-container hover:opacity-80"
              }`}
            >
              {profile.isBanned ? "Unban user" : "Ban user"}
            </button>
            {feedback && (
              <span
                className={`font-label text-xs font-semibold ${
                  feedback.type === "success" ? "text-green-700" : "text-yellow-700"
                }`}
              >
                {feedback.text}
              </span>
            )}
          </div>
        </Panel>
      </section>

      <Panel title="Payout history">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <MiniStat label="Pending" value={profile.payoutTotals.pending} tone={profile.payoutTotals.pending > 0 ? "warn" : "neutral"} />
          <MiniStat label="Sent" value={profile.payoutTotals.sent} tone="ok" />
          <MiniStat label="Failed" value={profile.payoutTotals.failed} tone={profile.payoutTotals.failed > 0 ? "error" : "neutral"} />
          <MiniStat label="Skipped" value={profile.payoutTotals.skipped} tone="neutral" />
          <MiniStat label="Abandoned" value={profile.payoutTotals.abandoned} tone={profile.payoutTotals.abandoned > 0 ? "error" : "neutral"} />
        </div>
      </Panel>

      <Panel title={`Recent submissions (${profile.recentSubmissions.length})`}>
        {profile.recentSubmissions.length === 0 ? (
          <p className="font-body text-sm text-on-surface-variant">
            No submissions yet.
          </p>
        ) : (
          <ul className="divide-y divide-outline-variant/20">
            {profile.recentSubmissions.map((s) => (
              <li key={s.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-label text-xs font-semibold">
                    <PayoutStatusChip status={s.payoutStatus} />
                    {s.isGoldCheck && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 font-label text-[10px] font-bold uppercase tracking-wider text-amber-800">
                        gold · {s.goldPassed ? "pass" : "fail"}
                      </span>
                    )}
                    <span className="font-body text-xs text-on-surface-variant">
                      {new Date(s.createdAt).toLocaleString("en-US")}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="font-label text-xs text-on-surface-variant">
                      chose <span className="font-bold text-on-surface">{s.choice}</span> ·{" "}
                      {unitsToUsdcDisplay(BigInt(s.payoutAmountUnits))} {profile.rewardSymbol}
                    </div>
                    <RetryPayoutButton
                      submissionId={s.id}
                      currentStatus={s.payoutStatus}
                      onSuccess={() => startTransition(() => router.refresh())}
                    />
                  </div>
                </div>
                <p className="mt-1 line-clamp-2 font-body text-sm text-on-surface">
                  {s.taskPrompt}
                </p>
                {s.payoutError && (
                  <div className="mt-1 rounded bg-error-container/20 p-1 font-mono text-[10px] text-error">
                    Error: {s.payoutError}
                  </div>
                )}
                {s.payoutTxHash && (
                  <a
                    href={`${process.env.NEXT_PUBLIC_EXPLORER_URL ?? "https://stellar.expert/explorer/testnet"}/tx/${s.payoutTxHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-block font-mono text-[10px] text-primary hover:underline"
                  >
                    {s.payoutTxHash.slice(0, 10)}…{s.payoutTxHash.slice(-6)}
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "ok" | "error";
}) {
  return (
    <div className="rounded-2xl bg-surface-container-lowest p-4 shadow-[0_4px_16px_rgba(25,28,30,0.04)]">
      <div className="font-label text-[10px] font-bold uppercase tracking-[0.2em] text-outline">
        {label}
      </div>
      <div
        className={`mt-1 font-headline text-xl font-extrabold ${
          tone === "ok" ? "text-secondary" : tone === "error" ? "text-error" : "text-on-surface"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "ok" | "warn" | "error";
}) {
  const toneClass =
    tone === "ok"
      ? "text-secondary"
      : tone === "warn"
        ? "text-yellow-700"
        : tone === "error"
          ? "text-error"
          : "text-on-surface";
  return (
    <div className="rounded-xl bg-surface-container-low p-3">
      <div className="font-label text-[10px] font-bold uppercase tracking-[0.2em] text-outline">
        {label}
      </div>
      <div className={`mt-1 font-headline text-2xl font-extrabold ${toneClass}`}>{value}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-[0_4px_16px_rgba(25,28,30,0.04)]">
      <h2 className="mb-3 font-label text-xs font-bold uppercase tracking-[0.2em] text-outline">
        {title}
      </h2>
      {children}
    </section>
  );
}

function DefinitionList({ rows }: { rows: Array<[string, string | null]> }) {
  return (
    <dl className="space-y-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-4 text-sm">
          <dt className="font-label text-xs font-semibold uppercase tracking-wider text-outline">
            {label}
          </dt>
          <dd className="font-body text-on-surface">{value || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

function PayoutStatusChip({ status }: { status: string }) {
  const tone =
    status === "sent" || status === "confirmed"
      ? "bg-secondary-container text-on-secondary-container"
      : status === "failed"
        ? "bg-error-container text-on-error-container"
        : status === "pending"
          ? "bg-yellow-100 text-yellow-800"
          : status === "abandoned"
            ? "bg-surface-container-high text-on-surface-variant line-through"
            : "bg-surface-container-high text-on-surface-variant";
  return (
    <span className={`rounded-full px-2 py-0.5 font-label text-[10px] font-bold uppercase tracking-wider ${tone}`}>
      {status}
    </span>
  );
}

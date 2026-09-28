import type { Asset } from "@stellar/stellar-sdk";
import prisma from "./prisma";
import { PAYOUT_MISMATCH } from "./payout-reconcile";
import { isFixtureTxHash } from "./qa-fixtures/hash";
import type { TxLookup } from "./stellar/client";
import { verifySettledPayout } from "./stellar/payout-verify";

// #40 D6 — the zero-unreconciled report.
//
// Reproducible from the database and Horizon alone, and read-only against both.
// Every submission in the window is counted by status. Every one that carries a
// broadcast hash ends in exactly one place: reconciled (Horizon shows it applied
// as owed), pending (sent, inside its grace period), excluded (a hash Horizon
// can never answer for, with the reason), or unreconciled under one or more
// named kinds. Zero means the unreconciled list is empty.

/** Why a payout is not reconciled. One row may carry more than one. */
export type UnreconciledKind =
  /** `sent` for longer than the grace period without being confirmed. */
  | "sent_overdue"
  /** `failed` or `abandoned`, yet carrying a hash: something was broadcast. */
  | "terminal_with_hash"
  /** `needs_reconciliation`: accepted by Horizon, never recorded (D5 settles these on proof). */
  | "held"
  /** `needs_reconciliation` because what applied does not match the submission (D4). */
  | "held_mismatch"
  /** An `open` payout attempt past its `expiresAt`, not yet settled. */
  | "attempt_expired_open"
  /** A hash recorded on more than one submission. */
  | "shared_hash"
  /** More than one `confirmed` payout attempt for one submission. */
  | "multiple_landed_attempts"
  /** `confirmed`, but its envelope does not pay what the submission owed. */
  | "horizon_mismatch"
  /** `confirmed`, but Horizon shows it included and failed. */
  | "horizon_failed"
  /** `confirmed`, but Horizon has no such transaction. */
  | "horizon_missing"
  /** `confirmed`, but Horizon could not be read for it. */
  | "horizon_unreadable"
  /** `confirmed`, and the report was run without Horizon. */
  | "horizon_unchecked"
  /** `confirmed`, but its payout job carries no broadcast tuple, so no cap counts it. */
  | "payout_job_tuple_missing";

export interface Finding {
  kind: UnreconciledKind;
  submissionId: string;
  status: string;
  hash: string | null;
  detail: string;
}

export interface Excluded {
  submissionId: string;
  status: string;
  hash: string;
}

export interface ReconcileReport {
  generatedAt: string;
  window: { since: string; until: string };
  sentOverdueMinutes: number;
  horizonChecked: boolean;
  totals: {
    submissions: number;
    byStatus: Record<string, { count: number; units: string }>;
  };
  reconciled: { submissionId: string; hash: string }[];
  pending: { submissionId: string; hash: string; sentAt: string }[];
  excluded: {
    /** Minted by `lib/qa-fixtures`; never broadcast. */
    qaFixture: Excluded[];
    /** `0x…` hashes from before the move to Stellar; Horizon cannot answer for them. */
    legacyEvm: Excluded[];
  };
  unreconciled: Finding[];
  zeroUnreconciled: boolean;
  volume: VolumeSummary;
}

/** What the D4 volume proof (#49) must reach. */
export interface VolumeTargets {
  settlements: number;
  wallets: number;
}

/**
 * #49 — the window read as a volume proof. Every count is of submissions, and a
 * submission is counted once however many findings it carries.
 */
export interface VolumeSummary {
  /** Reconciled on Horizon: settled exactly as owed. */
  successful: number;
  /** Distinct wallets among the successful payouts. */
  uniqueWallets: number;
  /** `skipped`: refused by a quality guard, so nothing was owed. */
  rejected: number;
  /** `failed` or `abandoned`. */
  failed: number;
  /** Carrying a `shared_hash` or `multiple_landed_attempts` finding. */
  duplicate: number;
  /** Carrying any finding. */
  unreconciled: number;
  /** Successful payouts per wallet, most first. Addresses are shortened, never whole. */
  wallets: { wallet: string; payouts: number }[];
  targets: VolumeTargets | null;
  /** Null when no targets were given. */
  met: boolean | null;
  /** Why the targets are not met; empty when they are, or when none were given. */
  shortfalls: string[];
}

/** Horizon, and what a payout on it must have paid. */
export interface ReportHorizon {
  lookupTx(hash: string): Promise<TxLookup>;
  expected: { payoutAccount: string; asset: Asset };
}

export interface ReportOptions {
  since: Date;
  until: Date;
  /** How long a payout may stay `sent` before it counts as unreconciled. */
  sentOverdueMs?: number;
  /** Without it, no `confirmed` payout can be shown reconciled. */
  horizon: ReportHorizon | null;
  /** Judge the window against these (#49). Without them the volume is counted, not judged. */
  targets?: VolumeTargets;
}

const DEFAULT_SENT_OVERDUE_MS = 30 * 60_000;
const LEGACY_EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
const DUPLICATE_KINDS: ReadonlySet<UnreconciledKind> = new Set(["shared_hash", "multiple_landed_attempts"]);

export async function buildReconcileReport(opts: ReportOptions): Promise<ReconcileReport> {
  const sentOverdueMs = opts.sentOverdueMs ?? DEFAULT_SENT_OVERDUE_MS;
  const now = Date.now();

  const rows = await prisma.submission.findMany({
    where: { createdAt: { gte: opts.since, lt: opts.until } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      payoutStatus: true,
      payoutTxHash: true,
      payoutAmountUnits: true,
      payoutError: true,
      walletAddress: true,
      createdAt: true,
      payoutJob: { select: { txHash: true, amountUnits: true, broadcastAt: true } },
      payoutAttempts: { select: { status: true, expiresAt: true, envelopeHash: true } },
    },
  });

  const byStatus: Record<string, { count: number; units: bigint }> = {};
  for (const row of rows) {
    const bucket = (byStatus[row.payoutStatus] ??= { count: 0, units: 0n });
    bucket.count++;
    bucket.units += row.payoutAmountUnits;
  }

  // A hash is shared if any submission, in the window or not, also carries it.
  const hashes = [...new Set(rows.flatMap((r) => (r.payoutTxHash ? [r.payoutTxHash] : [])))];
  const shared = new Set(
    (
      await prisma.submission.groupBy({
        by: ["payoutTxHash"],
        where: { payoutTxHash: { in: hashes } },
        _count: { _all: true },
      })
    )
      .filter((g) => g._count._all > 1)
      .map((g) => g.payoutTxHash!),
  );

  const report: ReconcileReport = {
    generatedAt: new Date(now).toISOString(),
    window: { since: opts.since.toISOString(), until: opts.until.toISOString() },
    sentOverdueMinutes: sentOverdueMs / 60_000,
    horizonChecked: opts.horizon !== null,
    totals: {
      submissions: rows.length,
      byStatus: Object.fromEntries(
        Object.entries(byStatus)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([status, b]) => [status, { count: b.count, units: b.units.toString() }]),
      ),
    },
    reconciled: [],
    pending: [],
    excluded: { qaFixture: [], legacyEvm: [] },
    unreconciled: [],
    zeroUnreconciled: false,
    volume: emptyVolume(),
  };
  const paidPerWallet = new Map<string, number>();

  for (const row of rows) {
    const hash = row.payoutTxHash;
    const status = row.payoutStatus;
    const found: Finding[] = [];
    const flag = (kind: UnreconciledKind, detail: string) =>
      found.push({ kind, submissionId: row.id, status, hash, detail });

    // Journal checks hold whatever the row's hash looks like.
    const expiredOpen = row.payoutAttempts.filter((a) => a.status === "open" && a.expiresAt.getTime() < now);
    if (expiredOpen.length) {
      flag("attempt_expired_open", `open envelope ${expiredOpen.map((a) => a.envelopeHash).join(", ")} is past its time bounds`);
    }
    const landed = row.payoutAttempts.filter((a) => a.status === "confirmed");
    if (landed.length > 1) {
      flag("multiple_landed_attempts", `${landed.length} confirmed envelopes: ${landed.map((a) => a.envelopeHash).join(", ")}`);
    }

    // F6: exclusion is about the hash Horizon can never answer for, not about
    // the row. The journal findings above are database facts that hold whatever
    // the hash looks like, so an excluded row still reports them — skipping the
    // append (as a `continue` here used to) let a QA fixture or a legacy EVM
    // hash hide a real `attempt_expired_open` or `multiple_landed_attempts` and
    // still headline `zeroUnreconciled`.
    const excluded = hash ? excludedBucket(report, hash) : null;
    if (hash && excluded) {
      excluded.push({ submissionId: row.id, status, hash });
    } else if (hash) {
      if (shared.has(hash)) flag("shared_hash", `hash ${hash} is recorded on more than one submission`);

      if (status === "sent") {
        const sentAt = row.payoutJob?.broadcastAt ?? row.createdAt;
        if (now - sentAt.getTime() > sentOverdueMs) {
          flag("sent_overdue", `sent at ${sentAt.toISOString()}, not confirmed within ${sentOverdueMs / 60_000} minutes`);
        } else if (!found.length) {
          report.pending.push({ submissionId: row.id, hash, sentAt: sentAt.toISOString() });
        }
      } else if (status === "failed" || status === "abandoned") {
        flag("terminal_with_hash", `${status}, yet carries broadcast hash ${hash}`);
      } else if (status === "needs_reconciliation") {
        if (row.payoutError?.startsWith(PAYOUT_MISMATCH)) flag("held_mismatch", row.payoutError);
        else flag("held", row.payoutError ?? "held for reconciliation");
      } else if (status === "confirmed") {
        // F4: a payout the quarantine path recorded leaves its job without the
        // `txHash`/`amountUnits`/`broadcastAt` tuple that both rolling caps sum.
        // The reconciler repairs it when it confirms a held payment; anything
        // that still reads confirmed without one is spend no cap can see, and
        // the report is where that has to surface rather than in a silent
        // under-count. A submission with no job row at all predates #37 and is
        // not what this is about.
        const job = row.payoutJob;
        if (job && (job.txHash === null || job.amountUnits === null || job.broadcastAt === null)) {
          flag(
            "payout_job_tuple_missing",
            `confirmed under ${hash}, but its payout job carries no broadcast tuple, so the daily caps do not count it`,
          );
        }
        const onChain = await checkOnHorizon(opts.horizon, hash, row.walletAddress, row.payoutAmountUnits);
        if (onChain) flag(onChain.kind, onChain.detail);
        else if (!found.length) {
          report.reconciled.push({ submissionId: row.id, hash });
          // Horizon matched the envelope to this wallet, so it is never null here.
          paidPerWallet.set(row.walletAddress!, (paidPerWallet.get(row.walletAddress!) ?? 0) + 1);
        }
      }
    }

    report.unreconciled.push(...found);
  }

  report.zeroUnreconciled = report.unreconciled.length === 0;
  report.volume = summarizeVolume(report, rows, paidPerWallet, opts.targets ?? null);
  return report;
}

function emptyVolume(): VolumeSummary {
  const none = { successful: 0, uniqueWallets: 0, rejected: 0, failed: 0, duplicate: 0, unreconciled: 0 };
  return { ...none, wallets: [], targets: null, met: null, shortfalls: [] };
}

function summarizeVolume(
  report: ReconcileReport,
  rows: { payoutStatus: string }[],
  paidPerWallet: Map<string, number>,
  targets: VolumeTargets | null,
): VolumeSummary {
  const submissionsWith = (match: (f: Finding) => boolean) =>
    new Set(report.unreconciled.filter(match).map((f) => f.submissionId)).size;

  const volume: VolumeSummary = {
    successful: report.reconciled.length,
    uniqueWallets: paidPerWallet.size,
    rejected: rows.filter((r) => r.payoutStatus === "skipped").length,
    failed: rows.filter((r) => r.payoutStatus === "failed" || r.payoutStatus === "abandoned").length,
    duplicate: submissionsWith((f) => DUPLICATE_KINDS.has(f.kind)),
    unreconciled: submissionsWith(() => true),
    wallets: [...paidPerWallet]
      .map(([wallet, payouts]) => ({ wallet: shortenWallet(wallet), payouts }))
      .sort((a, b) => b.payouts - a.payouts || a.wallet.localeCompare(b.wallet)),
    targets,
    met: null,
    shortfalls: [],
  };
  if (!targets) return volume;

  if (volume.successful < targets.settlements) volume.shortfalls.push(`${volume.successful} of ${targets.settlements} settlements`);
  if (volume.uniqueWallets < targets.wallets) volume.shortfalls.push(`${volume.uniqueWallets} of ${targets.wallets} unique wallets`);
  if (volume.duplicate) volume.shortfalls.push(`${volume.duplicate} duplicate`);
  if (volume.unreconciled) volume.shortfalls.push(`${volume.unreconciled} unreconciled`);
  volume.met = volume.shortfalls.length === 0;
  return volume;
}

/** `GABC…WXYZ`: enough to match a wallet on stellar.expert, not enough to list the cohort. */
function shortenWallet(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * The `excluded` list a hash belongs in, or null when Horizon can answer for it.
 * Both kinds are hashes no Horizon lookup can ever resolve: one was minted by
 * the QA fixtures and never broadcast, the other predates the move to Stellar.
 */
function excludedBucket(report: ReconcileReport, hash: string): Excluded[] | null {
  if (isFixtureTxHash(hash)) return report.excluded.qaFixture;
  if (LEGACY_EVM_HASH.test(hash)) return report.excluded.legacyEvm;
  return null;
}

/** Null when Horizon shows the payout applied exactly as owed. */
async function checkOnHorizon(
  horizon: ReportHorizon | null,
  hash: string,
  destination: string | null,
  amountUnits: bigint,
): Promise<{ kind: UnreconciledKind; detail: string } | null> {
  if (!horizon) return { kind: "horizon_unchecked", detail: "report run without Horizon; nothing proves this applied" };

  let lookup: TxLookup;
  try {
    lookup = await horizon.lookupTx(hash);
  } catch (err) {
    return { kind: "horizon_unreadable", detail: `Horizon read failed: ${(err as Error).message}` };
  }
  if (lookup.status === "not_found") return { kind: "horizon_missing", detail: "Horizon has no such transaction" };
  if (lookup.status === "failed") return { kind: "horizon_failed", detail: "Horizon shows it included and failed" };
  if (!destination) return { kind: "horizon_mismatch", detail: "submission has no bound wallet to check against" };

  const verdict = verifySettledPayout(lookup.envelopeXdr, { ...horizon.expected, destination, amountUnits });
  return verdict.ok ? null : { kind: "horizon_mismatch", detail: verdict.mismatches.join("; ") };
}

/** The reviewer-readable form of the same report. */
export function renderReconcileMarkdown(r: ReconcileReport): string {
  const lines: string[] = [];
  lines.push("# Payout reconcile report", "");
  lines.push(
    r.zeroUnreconciled
      ? "**Zero unreconciled.** Every broadcast payout in the window is reconciled, pending inside its grace period, or excluded for the reason given."
      : `**${r.unreconciled.length} unreconciled** finding${r.unreconciled.length === 1 ? "" : "s"}. Each is listed below.`,
    "",
  );
  lines.push(`- Window: ${r.window.since} to ${r.window.until} (by submission time)`);
  lines.push(`- Generated: ${r.generatedAt}`);
  lines.push(`- Horizon checked: ${r.horizonChecked ? "yes" : "**no** — no confirmed payout can be shown reconciled"}`);
  lines.push(`- A \`sent\` payout counts as overdue after ${r.sentOverdueMinutes} minutes`, "");

  lines.push("## Submissions by payout status", "", "| Status | Count | Units |", "| --- | ---: | ---: |");
  for (const [status, b] of Object.entries(r.totals.byStatus)) lines.push(`| ${status} | ${b.count} | ${b.units} |`);
  lines.push(`| **all** | **${r.totals.submissions}** | |`, "");

  lines.push("## Broadcast payouts", "", "| | Count |", "| --- | ---: |");
  lines.push(`| Reconciled on Horizon | ${r.reconciled.length} |`);
  lines.push(`| Pending, inside the grace period | ${r.pending.length} |`);
  lines.push(`| Excluded: QA fixture hash | ${r.excluded.qaFixture.length} |`);
  lines.push(`| Excluded: pre-Stellar EVM hash | ${r.excluded.legacyEvm.length} |`);
  lines.push(`| **Unreconciled findings** | **${r.unreconciled.length}** |`, "");

  const v = r.volume;
  lines.push("## Volume", "");
  if (v.targets) {
    lines.push(
      v.met
        ? `**Volume target met:** at least ${v.targets.settlements} settlements across at least ${v.targets.wallets} unique wallets, with nothing duplicate or unreconciled.`
        : `**Volume target not met:** ${v.shortfalls.join("; ")}.`,
      "",
    );
  }
  lines.push("| Outcome | Submissions |", "| --- | ---: |");
  lines.push(`| Successful (reconciled on Horizon) | ${v.successful} |`);
  lines.push(`| Unique wallets paid | ${v.uniqueWallets} |`);
  lines.push(`| Rejected by a quality guard | ${v.rejected} |`);
  lines.push(`| Failed or abandoned | ${v.failed} |`);
  lines.push(`| Duplicate | ${v.duplicate} |`);
  lines.push(`| Unreconciled | ${v.unreconciled} |`, "");
  if (v.wallets.length) {
    lines.push("Wallets are shortened; each full address is on the linked transactions.", "");
    lines.push("| Wallet | Payouts |", "| --- | ---: |");
    for (const w of v.wallets) lines.push(`| \`${w.wallet}\` | ${w.payouts} |`);
    lines.push("");
  }

  if (r.unreconciled.length) {
    lines.push("## Unreconciled", "", "| Kind | Submission | Status | Hash | Detail |", "| --- | --- | --- | --- | --- |");
    for (const f of r.unreconciled) {
      lines.push(`| ${f.kind} | ${f.submissionId} | ${f.status} | ${f.hash ?? "—"} | ${f.detail.replaceAll("|", "\\|")} |`);
    }
    lines.push("");
  }

  const excluded = [...r.excluded.qaFixture.map((e) => ({ ...e, why: "QA fixture" })), ...r.excluded.legacyEvm.map((e) => ({ ...e, why: "pre-Stellar EVM" }))];
  if (excluded.length) {
    lines.push("## Excluded", "", "Hashes Horizon can never answer for. Listed so nothing is silently dropped.", "");
    lines.push("| Why | Submission | Status | Hash |", "| --- | --- | --- | --- |");
    for (const e of excluded) lines.push(`| ${e.why} | ${e.submissionId} | ${e.status} | ${e.hash} |`);
    lines.push("");
  }
  return lines.join("\n");
}

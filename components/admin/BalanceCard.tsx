"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatUnits, parseUnits } from "viem";
import { REWARD_TOKEN_DECIMALS, REWARD_TOKEN_SYMBOL } from "@/lib/constants";

interface LedgerEntry {
  type: "DEPOSIT" | "DEBIT_REWARD" | "DEBIT_FEE" | "REFUND";
  amountWei: string;
  note: string | null;
  submissionId: string | null;
  createdAt: string;
}

interface BalanceCardProps {
  campaignId: string;
  initialBalanceWei: string;
  initialEstimated: number | null;
  initialLedger: LedgerEntry[];
  isSuperAdmin: boolean;
}

const LEDGER_LABELS: Record<LedgerEntry["type"], string> = {
  DEPOSIT: "Deposit",
  DEBIT_REWARD: "Labeler reward",
  DEBIT_FEE: "Platform fee",
  REFUND: "Refund",
};

const LOW_BALANCE_THRESHOLD = 100;

export default function BalanceCard({
  campaignId,
  initialBalanceWei,
  initialEstimated,
  initialLedger,
  isSuperAdmin,
}: BalanceCardProps) {
  const router = useRouter();
  const [balanceWei, setBalanceWei] = useState(initialBalanceWei);
  const [estimated, setEstimated] = useState(initialEstimated);
  const [ledger, setLedger] = useState(initialLedger);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const balanceFormatted = formatUnits(BigInt(balanceWei), REWARD_TOKEN_DECIMALS);
  const isLowBalance = estimated !== null && estimated < LOW_BALANCE_THRESHOLD;

  async function handleDeposit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    let amountWei: bigint;
    try {
      amountWei = parseUnits(amount, REWARD_TOKEN_DECIMALS);
      if (amountWei <= 0n) throw new Error();
    } catch {
      setError("Enter a valid positive amount.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/admin/campaigns/${campaignId}/deposit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountWei: amountWei.toString(), note: note || undefined }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Deposit failed. Try again.");
        return;
      }

      const data = await res.json();
      setBalanceWei(data.balanceWei);
      setEstimated(data.estimatedSubmissionsRemaining);
      setAmount("");
      setNote("");

      // Optimistically prepend the new deposit to the ledger from data we already
      // have, instead of an extra GET /balance round-trip. router.refresh() below
      // re-renders the server components (e.g. campaign list) with the new balance.
      setLedger((prev) => [
        {
          type: "DEPOSIT",
          amountWei: amountWei.toString(),
          note: note || null,
          submissionId: null,
          createdAt: new Date().toISOString(),
        },
        ...prev,
      ]);

      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-2xl border border-outline-variant bg-surface-container-low p-6 space-y-4">
      <h2 className="font-headline text-lg font-semibold text-on-surface">Campaign Balance</h2>

      {isLowBalance && (
        <div className="rounded-lg bg-amber-50 border border-amber-300 px-4 py-2 text-sm text-amber-800">
          Low balance — approximately {estimated} submission{estimated !== 1 ? "s" : ""} remaining.
          {isSuperAdmin ? " Credit the balance below." : " Contact your account manager to top up."}
        </div>
      )}

      <div className="flex gap-8">
        <div>
          <p className="text-xs text-on-surface-variant uppercase tracking-wide">Balance</p>
          <p className="text-2xl font-bold text-on-surface">
            {Number(balanceFormatted).toFixed(2)} {REWARD_TOKEN_SYMBOL}
          </p>
        </div>
        <div>
          <p className="text-xs text-on-surface-variant uppercase tracking-wide">Est. submissions</p>
          <p className="text-2xl font-bold text-on-surface">{estimated !== null ? estimated.toLocaleString() : "—"}</p>
        </div>
      </div>

      {isSuperAdmin && (
        <form onSubmit={handleDeposit} className="space-y-3 pt-2 border-t border-outline-variant">
          <p className="text-sm font-medium text-on-surface">Credit Balance</p>
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <label className="block text-xs text-on-surface-variant mb-1">
                Amount ({REWARD_TOKEN_SYMBOL})
              </label>
              <input
                type="number"
                min="0.000001"
                step="any"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                required
                className="w-full rounded-lg border border-outline bg-surface px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs text-on-surface-variant mb-1">
                Memo (optional)
              </label>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                placeholder="e.g. Invoice #123"
                className="w-full rounded-lg border border-outline bg-surface px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "Crediting…" : "Credit"}
            </button>
          </div>
          {error && <p role="alert" className="text-xs text-error">{error}</p>}
        </form>
      )}

      {ledger.length > 0 && (
        <div className="pt-2 border-t border-outline-variant">
          <p className="text-xs font-medium text-on-surface-variant uppercase tracking-wide mb-2">Recent Activity</p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-on-surface-variant">
                <th className="pb-1 font-medium">Type</th>
                <th className="pb-1 font-medium">Amount</th>
                <th className="pb-1 font-medium">Note</th>
                <th className="pb-1 font-medium">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {ledger.map((entry, i) => (
                <tr key={`${entry.createdAt}-${entry.type}-${i}`}>
                  <td className="py-1 text-on-surface">{LEDGER_LABELS[entry.type]}</td>
                  <td className="py-1 text-on-surface">
                    {entry.type === "DEPOSIT" || entry.type === "REFUND" ? "+" : "−"}
                    {Number(formatUnits(BigInt(entry.amountWei), REWARD_TOKEN_DECIMALS)).toFixed(4)}{" "}
                    {REWARD_TOKEN_SYMBOL}
                  </td>
                  <td className="py-1 text-on-surface-variant">{entry.note ?? "—"}</td>
                  <td className="py-1 text-on-surface-variant">
                    {new Date(entry.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ledger.length === 0 && (
        <p className="text-sm text-on-surface-variant">No transactions yet.</p>
      )}
    </div>
  );
}

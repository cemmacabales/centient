import type { HealthAlert } from "./health-alert";
import type { WalletHealth } from "./stellar/balance";

type WalletBalanceAlertInput = Pick<
  WalletHealth,
  | "address"
  | "assetStatus"
  | "availableXlmBalance"
  | "sponsoredReserveXlm"
  | "usdcBalance"
>;

export function walletBalanceAlerts(health: WalletBalanceAlertInput): HealthAlert[] {
  const alerts: HealthAlert[] = [];
  for (const asset of ["usdc", "xlm"] as const) {
    const status = health.assetStatus[asset];
    if (status === "healthy" || status === "unknown") continue;

    const isUsdc = asset === "usdc";
    alerts.push({
      key: `wallet-${asset}-${status}`,
      severity: status === "page" ? "PAGE" : "WARN",
      title: `${isUsdc ? "USDC reward" : "XLM fee"} balance is ${status === "page" ? "critically low" : "low"}`,
      lines: [
        isUsdc
          ? `${health.usdcBalance} USDC remains in the reward float`
          : `${health.availableXlmBalance} XLM is spendable (${health.sponsoredReserveXlm} XLM reserved)`,
        `Platform wallet: ${health.address}`,
      ],
    });
  }
  return alerts;
}

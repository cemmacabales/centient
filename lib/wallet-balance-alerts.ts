import type { HealthAlert } from "./health-alert";
import type { WalletHealth, WalletMonitoringStatus } from "./stellar/balance";

type WalletBalanceAlertInput = Pick<
  WalletHealth,
  | "address"
  | "assetStatus"
  | "availableXlmBalance"
  | "sponsoredReserveXlm"
  | "usdcBalance"
> & {
  // HealthMonitorInput is extended with this field in Task 5. Keep the existing
  // subset callers valid while direct wallet reads always supply a real state.
  monitoringStatus?: WalletMonitoringStatus;
};

export function walletBalanceAlerts(health: WalletBalanceAlertInput): HealthAlert[] {
  if (health.monitoringStatus === "unconfigured") {
    return [{
      key: "wallet-monitoring-unconfigured",
      severity: "WARN",
      title: "Wallet monitoring is not configured",
      lines: ["Configure the Stellar platform wallet before relying on balance alerts"],
    }];
  }
  if (health.monitoringStatus === "error") {
    return [{
      key: "wallet-monitoring-unavailable",
      severity: "PAGE",
      title: "Wallet monitoring is unavailable",
      lines: [`Platform wallet: ${health.address}`],
    }];
  }

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

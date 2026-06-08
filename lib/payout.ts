import { createPublicClient, createWalletClient, http, parseUnits, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  REWARD_AMOUNT,
  REWARD_TOKEN_ADDRESS,
  REWARD_TOKEN_DECIMALS,
  activeChain,
  activeRpcUrl,
} from "./constants";
import { checkPayoutCap, maybeSendCapAlert, PayoutCapError } from "./payout-cap";

function publicClient() {
  return createPublicClient({ chain: activeChain(), transport: http(activeRpcUrl()) });
}

function walletClient() {
  const key = process.env.PAYOUT_PRIVATE_KEY;
  if (!key) {
    throw new Error("PAYOUT_PRIVATE_KEY is not configured");
  }
  return createWalletClient({
    account: privateKeyToAccount(key as `0x${string}`),
    chain: activeChain(),
    transport: http(activeRpcUrl()),
  });
}

export { PayoutCapError };

export async function payReward(to: `0x${string}`, amountWei?: bigint): Promise<`0x${string}`> {
  const amount = amountWei ?? rewardInWei();

  await checkPayoutCap(amount);

  const txHash = await walletClient().writeContract({
    address: REWARD_TOKEN_ADDRESS,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, amount],
    gas: 100_000n,
  });

  maybeSendCapAlert().catch(() => {});

  return txHash;
}

export async function waitForTx(hash: `0x${string}`) {
  return publicClient().waitForTransactionReceipt({ hash, timeout: 30_000 });
}

export function rewardInWei(): bigint {
  return parseUnits(REWARD_AMOUNT, REWARD_TOKEN_DECIMALS);
}

export function resolveRewardWei(
  taskRewardWei: bigint | null,
  campaignRewardWei: bigint | null,
): bigint {
  if (taskRewardWei != null && taskRewardWei > 0n) return taskRewardWei;
  if (campaignRewardWei != null && campaignRewardWei > 0n) return campaignRewardWei;
  return rewardInWei();
}

export class PayoutCapError extends Error {
  constructor(
    message: string,
    public readonly currentWei: bigint,
    public readonly capWei: bigint,
  ) {
    super(message);
    this.name = "PayoutCapError";
  }
}

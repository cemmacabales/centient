import { createPublicClient, createWalletClient, http, parseUnits, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Mutex } from "async-mutex";
import {
  REWARD_AMOUNT,
  REWARD_TOKEN_ADDRESS,
  REWARD_TOKEN_DECIMALS,
  activeChain,
  activeRpcUrl,
} from "./constants";

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

const _walletClient = walletClient();

const nonceMutex = new Mutex();

export async function payReward(to: `0x${string}`, amountWei?: bigint): Promise<`0x${string}`> {
  const amount = amountWei ?? rewardInWei();
  return nonceMutex.runExclusive(async () => {
    try {
      return await _walletClient.writeContract({
        address: REWARD_TOKEN_ADDRESS,
        abi: erc20Abi,
        functionName: "transfer",
        args: [to, amount],
        gas: 100_000n,
      });
    } catch (err: any) {
      const isNonceError =
        err?.cause?.message?.includes("nonce too low") ||
        err?.cause?.message?.includes("underpriced") ||
        err?.message?.includes("nonce too low") ||
        err?.message?.includes("underpriced") ||
        (typeof err?.cause?.code === "string" && err.cause.code.includes("NONCE_"));
      if (isNonceError) {
        const address = _walletClient.account.address;
        const freshNonce = await publicClient().getTransactionCount({ address });
        return await _walletClient.writeContract({
          address: REWARD_TOKEN_ADDRESS,
          abi: erc20Abi,
          functionName: "transfer",
          args: [to, amount],
          gas: 100_000n,
          nonce: freshNonce,
        });
      }
      throw err;
    }
  });
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
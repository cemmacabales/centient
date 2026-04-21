import { createPublicClient, createWalletClient, http, parseUnits, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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

export async function payReward(to: `0x${string}`): Promise<`0x${string}`> {
  return walletClient().writeContract({
    address: REWARD_TOKEN_ADDRESS,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, parseUnits(REWARD_AMOUNT, REWARD_TOKEN_DECIMALS)],
    gas: 100_000n,
  });
}

export async function waitForTx(hash: `0x${string}`) {
  return publicClient().waitForTransactionReceipt({ hash, timeout: 30_000 });
}

export function rewardInWei(): bigint {
  return parseUnits(REWARD_AMOUNT, REWARD_TOKEN_DECIMALS);
}

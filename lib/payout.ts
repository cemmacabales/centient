import { createPublicClient, createWalletClient, http, parseUnits, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { CUSD_MAINNET, REWARD_CUSD } from "./constants";

const account = privateKeyToAccount(process.env.PAYOUT_PRIVATE_KEY as `0x${string}`);

const publicClient = createPublicClient({
  chain: celo,
  transport: http(process.env.CELO_RPC_URL ?? "https://forno.celo.org"),
});

const walletClient = createWalletClient({
  account,
  chain: celo,
  transport: http(process.env.CELO_RPC_URL ?? "https://forno.celo.org"),
});

export async function payCUSD(to: `0x${string}`): Promise<`0x${string}`> {
  return walletClient.writeContract({
    address: CUSD_MAINNET,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, parseUnits(REWARD_CUSD, 18)],
    gas: 100_000n,
  });
}

export async function waitForTx(hash: `0x${string}`) {
  return publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
}

export function rewardInWei(): bigint {
  return parseUnits(REWARD_CUSD, 18);
}

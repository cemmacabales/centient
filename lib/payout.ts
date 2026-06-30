import { createPublicClient, createWalletClient, http, parseUnits, erc20Abi, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Mutex } from "async-mutex";
import {
  REWARD_AMOUNT,
  REWARD_TOKEN_ADDRESS,
  REWARD_TOKEN_DECIMALS,
  activeChain,
  activeRpcUrl,
} from "./constants";
import { checkPayoutCap, maybeSendCapAlert, PayoutCapError } from "./payout-cap";
import { randomBytes } from "node:crypto";
import { isSimulationMode } from "./simulation";

export { PayoutCapError };

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

let _walletClient: ReturnType<typeof walletClient> | null = null;

function getWalletClient() {
  if (!_walletClient) {
    _walletClient = walletClient();
  }
  return _walletClient;
}

const nonceMutex = new Mutex();

// Local-sim only: a syntactically valid 0x + 64-hex hash, never broadcast.
function simulatedTxHash(): `0x${string}` {
  return `0x${randomBytes(32).toString("hex")}`;
}

export async function payReward(to: `0x${string}`, amountUnits?: bigint): Promise<`0x${string}`> {
  const amount = amountUnits ?? rewardInUnits();

  if (isSimulationMode()) {
    return simulatedTxHash();
  }

  await checkPayoutCap(amount);

  const txHash = await nonceMutex.runExclusive(async () => {
    try {
      return await getWalletClient().writeContract({
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
        const address = getWalletClient().account.address;
        const freshNonce = await publicClient().getTransactionCount({ address });
        return await getWalletClient().writeContract({
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

  maybeSendCapAlert().catch(() => {});

  return txHash;
}

export async function waitForTx(hash: `0x${string}`) {
  if (isSimulationMode()) {
    return { status: "success", transactionHash: hash } as unknown as TransactionReceipt;
  }
  return publicClient().waitForTransactionReceipt({ hash, timeout: 30_000 });
}

export function rewardInUnits(): bigint {
  return parseUnits(REWARD_AMOUNT, REWARD_TOKEN_DECIMALS);
}

export function resolveRewardUnits(
  taskRewardUnits: bigint | null,
  campaignRewardUnits: bigint | null,
): bigint {
  if (taskRewardUnits != null && taskRewardUnits > 0n) return taskRewardUnits;
  if (campaignRewardUnits != null && campaignRewardUnits > 0n) return campaignRewardUnits;
  return rewardInUnits();
}

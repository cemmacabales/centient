import {
  BASE_FEE,
  Operation,
  StrKey,
  TransactionBuilder,
  type Asset,
  type Transaction,
} from "@stellar/stellar-sdk";
import { networkPassphrase } from "./config";

const DEFAULT_TIMEOUT_SECONDS = 180;

/**
 * Build the exact CAP-33 transaction used by the spike for a brand-new,
 * zero-XLM recipient: begin sponsorship, create the account with 0 XLM, add its
 * USDC trustline, then end sponsorship. The sponsor account owns the sequence
 * and fee; the caller adds two sponsor signatures plus the recipient signature.
 */
export function buildSponsoredRecipientTx({
  sponsorAccount,
  recipientPublicKey,
  asset,
  fee = BASE_FEE,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
}: {
  sponsorAccount: ConstructorParameters<typeof TransactionBuilder>[0];
  recipientPublicKey: string;
  asset: Asset;
  fee?: string;
  timeoutSeconds?: number;
}): Transaction {
  if (!StrKey.isValidEd25519PublicKey(recipientPublicKey)) {
    throw new Error(
      `recipient must be a valid Stellar public key (G…), got "${recipientPublicKey}"`,
    );
  }
  if (!/^\d+$/.test(fee) || BigInt(fee) <= 0n) {
    throw new Error(`fee must be a positive integer stroop string, got "${fee}"`);
  }
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`timeoutSeconds must be a positive integer, got ${timeoutSeconds}`);
  }

  return new TransactionBuilder(sponsorAccount, {
    fee,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(
      Operation.beginSponsoringFutureReserves({ sponsoredId: recipientPublicKey }),
    )
    .addOperation(
      Operation.createAccount({
        destination: recipientPublicKey,
        startingBalance: "0",
      }),
    )
    .addOperation(Operation.changeTrust({ asset, source: recipientPublicKey }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: recipientPublicKey }))
    .setTimeout(timeoutSeconds)
    .build();
}

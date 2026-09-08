// The pinned testnet recipients the fixtures pay to.
//
// Provisioned once by `scripts/qa-provision-recipients.ts` and committed, so the
// seed command makes no network calls, needs no sponsor secret, and produces the
// same destinations on every run. QA cross-references these addresses against
// Horizon across runs; addresses that changed every run would make that
// impossible.
//
// Three shapes pin cleanly. The zero-XLM sponsored shape does not, and is not
// here: D1-TC-006 tests the sponsorship event itself, which happens exactly once
// per address, so it is minted fresh by its own command when that case is run.
import { readFileSync } from "node:fs";
import { StrKey } from "@stellar/stellar-sdk";

/** The recipient shapes a fixture can pay to, and what each one proves. */
export type RecipientShape =
  /** Funded, holds a USDC trustline for the configured issuer. The payable case. */
  | "withTrustline"
  /** Funded, no USDC trustline. Expect a permanent `op_no_trust` classification. */
  | "withoutTrustline"
  /** Never created on-chain. Expect a permanent no-destination classification. */
  | "neverCreated";

export const RECIPIENT_SHAPES: readonly RecipientShape[] = [
  "withTrustline",
  "withoutTrustline",
  "neverCreated",
];

export interface RecipientManifest {
  network: string;
  usdcIssuer: string;
  generatedAt: string;
  recipients: Record<RecipientShape, { address: string; note?: string }>;
}

function fail(reason: string): never {
  throw new Error(`qa-fixtures: recipient manifest is unusable — ${reason}`);
}

/**
 * Validate a parsed manifest into its typed shape.
 *
 * Every address is checked as a StrKey rather than assumed: a malformed one
 * would otherwise surface much later as a payout failure that looks like a rail
 * defect instead of a fixture defect, which is exactly the confusion QA cannot
 * afford during an evidence run.
 */
export function parseRecipientManifest(raw: unknown): RecipientManifest {
  if (typeof raw !== "object" || raw === null) fail("it is not an object");
  const candidate = raw as Record<string, unknown>;

  const network = candidate.network;
  if (typeof network !== "string" || network.trim() === "") {
    fail("it declares no network");
  }

  const usdcIssuer = candidate.usdcIssuer;
  if (typeof usdcIssuer !== "string" || !StrKey.isValidEd25519PublicKey(usdcIssuer)) {
    fail(`usdcIssuer is not a valid Stellar public key: ${String(usdcIssuer)}`);
  }

  const generatedAt = candidate.generatedAt;
  if (typeof generatedAt !== "string" || generatedAt.trim() === "") {
    fail("it records no generatedAt timestamp");
  }

  const recipients = candidate.recipients;
  if (typeof recipients !== "object" || recipients === null) {
    fail("it has no recipients block");
  }
  const recipientMap = recipients as Record<string, unknown>;

  const parsed = {} as RecipientManifest["recipients"];
  const seen = new Map<string, RecipientShape>();

  for (const shape of RECIPIENT_SHAPES) {
    const entry = recipientMap[shape];
    if (typeof entry !== "object" || entry === null) {
      fail(`it is missing the "${shape}" recipient`);
    }
    const { address, note } = entry as { address?: unknown; note?: unknown };
    if (typeof address !== "string" || !StrKey.isValidEd25519PublicKey(address)) {
      fail(`the "${shape}" address is not a valid Stellar public key: ${String(address)}`);
    }
    // Distinctness is the property that makes the shapes mean anything: two
    // shapes sharing an address would make a fixture prove the opposite of what
    // it claims, and would do so silently.
    const duplicate = seen.get(address);
    if (duplicate) {
      fail(`"${shape}" and "${duplicate}" share the address ${address}`);
    }
    seen.set(address, shape);

    parsed[shape] = { address, ...(typeof note === "string" ? { note } : {}) };
  }

  return {
    network: network.trim(),
    usdcIssuer,
    generatedAt,
    recipients: parsed,
  };
}

/** Default location of the committed manifest, resolved from this module. */
export function defaultManifestPath(): string {
  return new URL("./recipients.testnet.json", import.meta.url).pathname;
}

/** Read and validate the manifest from disk. */
export function loadRecipientManifest(path = defaultManifestPath()): RecipientManifest {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    throw new Error(
      `qa-fixtures: no recipient manifest at ${path}. Run ` +
        "`pnpm qa:recipients:provision` once to create it.",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    fail(`it is not valid JSON (${(err as Error).message})`);
  }

  return parseRecipientManifest(raw);
}

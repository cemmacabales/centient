// The refusal that stands between a QA fixture command and a real ledger.
//
// These commands write payout rows and delete them again. Run against a
// public-network configuration they would fabricate payment records beside real
// ones. So the gate is explicit rather than inherited: `stellarNetwork()` treats
// an unset `STELLAR_NETWORK` as testnet, which is a reasonable default for a
// read path and an unreasonable one for a destructive command. Here, unset is a
// refusal.
//
// The shape follows `resolvePayoutCoSigner`'s public-network refusal, including
// its treatment of an empty string as unset rather than as a value that might
// slip past a `!== "public"` check.

export interface QaFixtureEnv {
  STELLAR_NETWORK?: string;
  DATABASE_URL?: string;
  // Present so a real `process.env` is assignable: an all-optional interface is a
  // weak type, and TypeScript rejects `ProcessEnv` against it for having no
  // properties in common. Tests still pass narrow object literals.
  [key: string]: string | undefined;
}

export class QaFixtureGateError extends Error {
  readonly code = "qa_fixture_gate";
  constructor(message: string) {
    super(message);
    this.name = "QaFixtureGateError";
  }
}

/**
 * The active network, requiring it to have been stated.
 *
 * Deliberately stricter than `stellarNetwork()`: there is no default. A command
 * that writes and deletes payout rows should never infer which ledger it is
 * pointed at.
 */
export function requireTestnet(env: QaFixtureEnv = process.env): "testnet" {
  const raw = (env.STELLAR_NETWORK ?? "").trim().toLowerCase();

  if (raw === "") {
    throw new QaFixtureGateError(
      "qa-fixtures: STELLAR_NETWORK is not set. These commands write and delete " +
        "payout rows and refuse to guess which network they are pointed at — set " +
        "STELLAR_NETWORK=testnet explicitly.",
    );
  }
  if (raw !== "testnet") {
    throw new QaFixtureGateError(
      `qa-fixtures: refusing to run against STELLAR_NETWORK="${raw}". ` +
        "QA fixtures are testnet-only.",
    );
  }
  return "testnet";
}

/** The database URL, required to be present but never inspected further. */
export function requireDatabaseUrl(env: QaFixtureEnv = process.env): string {
  const url = (env.DATABASE_URL ?? "").trim();
  if (url === "") {
    throw new QaFixtureGateError("qa-fixtures: DATABASE_URL is not set.");
  }
  return url;
}

/**
 * Every precondition a fixture command shares, checked before it touches
 * anything. `manifestNetwork` is the network the pinned recipient file declares;
 * a mismatch means the addresses were provisioned on a different ledger than the
 * one now configured, which would seed fixtures pointing at accounts that do not
 * exist.
 */
export function assertFixturePreconditions(
  env: QaFixtureEnv = process.env,
  manifestNetwork?: string,
): { network: "testnet"; databaseUrl: string } {
  const network = requireTestnet(env);
  const databaseUrl = requireDatabaseUrl(env);

  if (manifestNetwork !== undefined && manifestNetwork !== network) {
    throw new QaFixtureGateError(
      `qa-fixtures: the pinned recipient manifest was provisioned for ` +
        `"${manifestNetwork}" but STELLAR_NETWORK is "${network}". Those addresses ` +
        "do not exist on the configured ledger.",
    );
  }

  return { network, databaseUrl };
}

// Which payout rows a QA reset is allowed to remove.
//
// Two fixture states must carry a transaction hash. `assertLedgerAgrees` checks
// for a broadcast hash *before* it checks status, and refusing on that hash is
// precisely what `qa-already-paid` and `qa-needs-reconciliation` exist to let QA
// observe. So a blanket "never touch a hashed row" reset would strand those two
// fixtures in the database permanently.
//
// The discriminator is the hash's *shape*, never a column the seeder set about
// itself. A marker column would mean the reset trusts the seeder's own claim
// about which rows are synthetic — and a row mislabelled by a bug would then be
// deleted despite carrying real funds. Shape is checkable independently of
// anything the seeder recorded, which is the whole point.
//
// Deletion requires BOTH halves: the hash must not look like a Horizon hash, and
// it must look like one this module minted. An unrecognised hash — entered by
// hand, written by another tool, truncated by a bad migration — is preserved
// rather than deleted. Preserving a row that did not need preserving costs QA a
// stale fixture; deleting one that carried a real payment destroys the evidence
// that the payment happened. Those costs are not symmetric.

/**
 * A Horizon transaction hash: 32 bytes rendered as hex.
 *
 * Horizon emits lowercase, but this accepts either case deliberately. Being
 * wrong in this direction can only ever *prevent* a deletion, never cause one.
 */
const HORIZON_TX_HASH = /^[0-9a-fA-F]{64}$/;

/**
 * A hash minted by `fixtureTxHash`. The `qa-` prefix guarantees it can never
 * collide with a Horizon hash: `q` is not a hex digit, so no string matching
 * this can also match `HORIZON_TX_HASH`.
 */
const FIXTURE_TX_HASH = /^qa-[0-9a-z]+-\d+$/;

/** A run id: lowercase alphanumeric, so it composes into a fixture hash. */
export const RUN_ID_PATTERN = /^[0-9a-z]+$/;

/**
 * Does this hash look like a real Horizon broadcast?
 *
 * `true` means the row records funds that actually left the wallet, and nothing
 * in this module may delete or rewrite it.
 */
export function isRealBroadcastHash(hash: string | null | undefined): boolean {
  return typeof hash === "string" && HORIZON_TX_HASH.test(hash.trim());
}

/** Was this hash minted by `fixtureTxHash`? */
export function isFixtureTxHash(hash: string | null | undefined): boolean {
  return typeof hash === "string" && FIXTURE_TX_HASH.test(hash.trim());
}

/**
 * Mint the synthetic hash for one fixture row.
 *
 * Validates the run id rather than trusting it, because a run id carrying an
 * unexpected character would produce a hash that `isFixtureTxHash` rejects — and
 * the row would then be un-resettable for a reason no one could see.
 */
export function fixtureTxHash(runId: string, index: number): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      `qa-fixtures: run id must be lowercase alphanumeric, got "${runId}"`,
    );
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`qa-fixtures: fixture hash index must be a non-negative integer, got ${index}`);
  }
  return `qa-${runId}-${index}`;
}

/**
 * May a reset delete the row carrying this hash?
 *
 * A row with no hash never broadcast anything and is always removable. A row
 * carrying a real hash never is. Everything else is removable only if this
 * module minted it.
 */
export function isResettableHash(hash: string | null | undefined): boolean {
  if (hash === null || hash === undefined || hash.trim() === "") return true;
  if (isRealBroadcastHash(hash)) return false;
  return isFixtureTxHash(hash);
}

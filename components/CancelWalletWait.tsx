/**
 * The way out while the page waits on the Freighter mobile app — for the
 * pairing or for a signature. Freighter can drop a request without answering,
 * and a wait with no control on it is a dead end until the timeout.
 */
export default function CancelWalletWait({ onCancel }: { onCancel: () => void }) {
  return (
    <button
      type="button"
      onClick={onCancel}
      className="font-label text-sm font-semibold text-on-surface-variant underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
    >
      Cancel
    </button>
  );
}

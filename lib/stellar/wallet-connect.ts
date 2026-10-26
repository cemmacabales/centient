// Freighter **mobile** over WalletConnect v2 — the transport wallet.ts falls
// back to when the browser extension isn't there (a phone browser, Freighter's
// own in-app browser, or a desktop without the extension installed).
//
// Why this exists: `@stellar/freighter-api` only ever talks to the *extension*.
// It posts a message on `window` and waits for the extension's content script to
// answer. Freighter mobile ships no content script — not even inside its own
// in-app browser, which injects only a marker:
//
//     window.stellar = { provider: "freighter", platform: "mobile", version }
//
// so every `freighter-api` call on a phone hangs or reports "not installed".
// Freighter mobile instead speaks WalletConnect v2 (it is built on
// `@reown/walletkit`), and that is what this module drives.
//
// The wallet side of this contract was read off Freighter mobile's own source
// (`src/ducks/walletKit.ts`, `src/helpers/walletKitUtil.ts`) rather than guessed:
//
//   namespace  "stellar"
//   chains     "stellar:pubnet" | "stellar:testnet"   ← note `pubnet`, not `public`
//   events     "accountsChanged"
//   methods    stellar_signXDR            { xdr }      → { signedXDR }
//              stellar_signAndSubmitXDR   { xdr }      → { status: "success" }
//              stellar_signMessage        { message }  → { signature }
//              stellar_signAuthEntry      { entryXdr } → { signedAuthEntry, signerAddress }
//
// Centient needs `stellar_signMessage` (the SEP-53 ownership proof behind
// sign-in, wallet claim and the payout-address proof) *and* `stellar_signXDR`
// (the recipient's half of the sponsored-trustline envelope). That rules out
// Stellar Wallets Kit, whose WalletConnect module exposes only the two XDR
// methods — hence talking to WalletConnect directly here.
//
// Two differences from the extension the callers depend on:
//
//   • `stellar_signMessage` returns a bare `{ signature }` with **no**
//     `signerAddress`, so the extension's "did the right account sign this?"
//     check has nothing to compare against. We verify the signature against the
//     expected address locally instead (see `signOwnership`) — a strictly
//     stronger guarantee than trusting a self-reported signer.
//   • Freighter mobile **rejects** a request whose CAIP chain doesn't match the
//     network the wallet is currently on, so the chain comes from
//     `caipChainId()` and `NEXT_PUBLIC_STELLAR_NETWORK` has to match
//     `STELLAR_NETWORK`.
//
// The SDK is loaded with dynamic `import()` inside each call, as in wallet.ts:
// it keeps ~1MB of relay/crypto code out of the initial bundle and off the
// server build, and it means a deployment with no WalletConnect project id
// never downloads it at all.
import { isValidStellarAddress, verify } from "./signature";
import { caipChainId, clientNetworkPassphrase } from "./config";
import {
  WalletError,
  type StellarProofAndTransaction,
  type StellarSignedMessage,
} from "./wallet-errors";

/** The `stellar` namespace methods we ask Freighter mobile to approve. */
const STELLAR_METHODS = [
  "stellar_signXDR",
  "stellar_signAndSubmitXDR",
  "stellar_signMessage",
  "stellar_signAuthEntry",
] as const;

/** The only session event the wallet emits. */
const STELLAR_EVENTS = ["accountsChanged"] as const;

/** WalletConnect's JSON-RPC error code for "the user said no". */
const WC_USER_REJECTED = 5000;

/**
 * How long `connect()` waits for the wallet to answer a pairing before giving
 * up. Long enough to switch apps, unlock Freighter and approve, short enough
 * that a contributor who walked away isn't left on a dialog that can never
 * close. `provider.connect()` has no deadline of its own that we can lean on
 * (sign-client's proposal expiry is thirty days), which is the hang #138
 * exists to remove.
 */
export const PAIRING_TIMEOUT_MS = 3 * 60_000;

/**
 * How long a signing request waits for Freighter before giving up. A request
 * sent over a session Freighter no longer holds is dropped there without a
 * word (its handler returns when it finds no active session for the account),
 * so without a deadline the contributor waits on a wallet that will never
 * answer.
 */
export const REQUEST_TIMEOUT_MS = 3 * 60_000;

/** WalletConnect's registry, which publishes each wallet's mobile deep link. */
const WC_EXPLORER_API = "https://explorer-api.walletconnect.com/v3/wallets";

/**
 * Where to send a phone when the registry can't say.
 *
 * `freighterwallet` is the scheme Freighter mobile registers with the OS, read
 * off its own build config — `CFBundleURLSchemes` in `ios/…/Info.plist` and
 * `deepLinkScheme` in `android/app/build.gradle`. The `wc` path is
 * WalletConnect's convention for the pairing entry point.
 *
 * This is a fallback, not the first choice: the wallet only pairs from a URL
 * containing the redirect string it was *built* with, and that value lives in
 * its private CI config, so this can open the app without the pairing landing.
 * The prompt therefore always keeps a manual path visible.
 */
const FREIGHTER_NATIVE_FALLBACK = "freighterwallet://wc";

/**
 * How a pairing should be handed to the user. `deepLink` is set only once the
 * registry has told us where Freighter mobile lives; `uri` is always present so
 * the UI can fall back to a QR code or a copy button.
 */
export interface WalletConnectPairing {
  /** The raw `wc:` pairing URI — render as a QR on desktop. */
  uri: string;
  /** A link that opens the Freighter app on this phone; null until resolved. */
  deepLink: string | null;
  /**
   * True when `deepLink` came from the WalletConnect registry, false when it is
   * {@link FREIGHTER_NATIVE_FALLBACK}. The prompt keeps a manual path visible
   * either way, but only promises the app will open when this is true.
   */
  linkIsExact: boolean;
}

type PairingListener = (pairing: WalletConnectPairing | null) => void;

const pairingListeners = new Set<PairingListener>();

/**
 * Watch for a pairing that needs the user's attention. The transport publishes
 * one when a fresh pairing starts and `null` once it resolves — so the UI can
 * show and hide a QR/deep-link prompt without `connect()` growing a parameter
 * and rippling through wallet-sign-in.ts, wallet-claim.ts and payout-setup.ts.
 *
 * @returns an unsubscribe function.
 */
export function onPairing(listener: PairingListener): () => void {
  pairingListeners.add(listener);
  return () => pairingListeners.delete(listener);
}

/** Tell every subscriber about the current pairing (or that it is over). */
function publishPairing(pairing: WalletConnectPairing | null): void {
  for (const listener of pairingListeners) listener(pairing);
}

/**
 * The WalletConnect project id from `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`.
 * Undefined when the deployment hasn't configured one, which disables this
 * transport entirely rather than failing mid-connect.
 */
export function walletConnectProjectId(): string | undefined {
  return process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() || undefined;
}

/** True when this deployment can offer the Freighter-mobile path at all. */
export function isWalletConnectConfigured(): boolean {
  return walletConnectProjectId() !== undefined;
}

/**
 * True when the page is running inside Freighter mobile's in-app browser, which
 * injects `window.stellar = { provider: "freighter", platform: "mobile" }` and
 * nothing else. Used only to word the UI ("Open Freighter" rather than "Scan
 * this code") — the transport choice doesn't depend on it, because there is no
 * extension in that browser either, so the normal fallback already applies.
 */
export function isFreighterInAppBrowser(): boolean {
  if (typeof window === "undefined") return false;
  const injected = (window as { stellar?: { provider?: unknown; platform?: unknown } }).stellar;
  return injected?.provider === "freighter" && injected?.platform === "mobile";
}

/** A coarse "this is a phone or tablet" check, for QR vs. deep link. */
export function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
}

/**
 * The shape of `@walletconnect/universal-provider` this module uses. Declared
 * structurally so tests can inject a stand-in without the real relay, and so
 * the import stays dynamic.
 */
export interface WalletConnectProvider {
  session?: {
    topic?: string;
    namespaces?: Record<string, { accounts?: string[] }>;
    peer?: { metadata?: { redirect?: { native?: string; universal?: string } } };
  };
  connect(opts: {
    namespaces: Record<string, { chains: string[]; methods: string[]; events: string[] }>;
  }): Promise<unknown>;
  request<T>(args: { method: string; params?: unknown }, chain?: string): Promise<T>;
  disconnect(): Promise<void>;
  on(event: string, listener: (...args: never[]) => void): void;
  /** The sign client underneath; see {@link dropSession} and {@link retireProvider}. */
  client?: {
    disconnect(params: { topic: string; reason: { code: number; message: string } }): Promise<void>;
    session: { delete(topic: string, reason: { code: number; message: string }): Promise<void> };
    core: {
      relayer: { transportClose(): Promise<void> };
      heartbeat: { stop(): void };
    };
  };
}

/** The SDK's reason for a dapp hanging up — `getSdkError("USER_DISCONNECTED")`. */
const USER_DISCONNECTED = { code: 6000, message: "User disconnected." };

let providerPromise: Promise<WalletConnectProvider> | null = null;

/** Replace the cached provider. Tests inject a stand-in; `null` clears it. */
export function setWalletConnectProvider(provider: WalletConnectProvider | null): void {
  // Wired exactly as a real provider is, so the pairing hand-off is testable.
  provider?.on("display_uri", onDisplayUri as (...args: never[]) => void);
  providerPromise = provider ? Promise.resolve(provider) : null;
}

/**
 * The relay hands us the pairing URI asynchronously, after `connect()` has
 * already been called, so the UI learns about it through the subscription.
 */
function onDisplayUri(uri: string): void {
  void publishPairingFor(uri);
}

/**
 * The shared provider, created on first use. Kept as the *promise* so two
 * concurrent callers can't race two relay connections into existence.
 */
async function getProvider(): Promise<WalletConnectProvider> {
  if (providerPromise) return providerPromise;

  const projectId = walletConnectProjectId();
  if (!projectId) {
    throw new WalletError(
      "walletconnect_unconfigured",
      "Connecting the Freighter mobile app isn't available on this deployment.",
    );
  }

  providerPromise = (async () => {
    const { UniversalProvider } = await import("@walletconnect/universal-provider");
    const provider = (await UniversalProvider.init({
      projectId,
      metadata: {
        name: "Centient",
        description: "Earn USDC for labelling data.",
        url: appUrl(),
        icons: [`${appUrl()}/logo-192.png`],
      },
    })) as unknown as WalletConnectProvider;

    provider.on("display_uri", onDisplayUri as (...args: never[]) => void);

    return provider;
  })();

  try {
    return await providerPromise;
  } catch (err) {
    providerPromise = null; // let the next attempt retry a failed init
    throw err;
  }
}

/** The dapp origin WalletConnect shows the user in the approval prompt. */
function appUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (typeof window !== "undefined") return window.location.origin;
  return "https://centient.xyz";
}

/**
 * Resolve where this pairing should be sent, then publish it to the UI.
 *
 * Published twice on purpose: once immediately, so a desktop can start drawing
 * its QR code without waiting on a network round trip, and again once the
 * registry answers. On a phone `warmUp` has usually already cached that answer,
 * so the second publish lands in the same tick as the first.
 *
 * Both publishes belong to the attempt that was live when the URI arrived, and
 * are dropped once it has settled. The relay can deliver a URI after a cancel
 * or timeout, and the registry can answer after one: reopening the prompt then
 * would leave a dialog whose Cancel has nothing left to cancel.
 */
async function publishPairingFor(uri: string): Promise<void> {
  const attempt = abandonPairing;
  if (!attempt) return;
  publishPairing({ uri, deepLink: null, linkIsExact: false });
  const link = await freighterMobileLink();
  if (abandonPairing !== attempt) return;
  publishPairing({
    uri,
    deepLink: formatNativeUrl(link ?? FREIGHTER_NATIVE_FALLBACK, uri),
    linkIsExact: link !== null,
  });
}

/** Memoized across pairings; only a *successful* lookup is kept (see below). */
let cachedMobileLink: string | undefined;

/**
 * Freighter's published mobile link, from the WalletConnect registry.
 *
 * Deliberately *not* hardcoded. Freighter mobile's iOS bundle registers the
 * scheme `freighterwallet` and its Android build the same, but the redirect
 * *path* its pairing handler matches on lives in the wallet's private build env
 * — it is not in the public repo, so any hand-written `freighterwallet://…`
 * would be a guess that silently drops the user on a dead link. The registry is
 * where the wallet itself publishes that value.
 *
 * Resolves to `null` when the lookup fails, and the UI falls back to the QR
 * code, which never depends on knowing the link. A failure is not cached: a
 * pairing is a deliberate act a few seconds apart, so a blip on the first
 * attempt shouldn't cost the user the deep link for the rest of the session.
 */
export async function freighterMobileLink(): Promise<string | null> {
  if (cachedMobileLink !== undefined) return cachedMobileLink;

  const projectId = walletConnectProjectId();
  if (!projectId) return null;

  try {
    const res = await fetch(
      `${WC_EXPLORER_API}?projectId=${encodeURIComponent(projectId)}&search=freighter&entries=5&page=1`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      listings?: Record<string, { name?: string; mobile?: { native?: string; universal?: string } }>;
    };
    for (const listing of Object.values(body.listings ?? {})) {
      if (!/freighter/i.test(listing.name ?? "")) continue;
      const link = listing.mobile?.native || listing.mobile?.universal;
      if (link) return (cachedMobileLink = link);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Hang the pairing URI off a wallet's published link, the way WalletConnect
 * does: the wallet is opened at that link with `?uri=<encoded pairing uri>`,
 * and Freighter's handler reads the `uri` param back out and pairs on it.
 *
 * Three shapes have to survive, because the registry publishes all three:
 *
 *   freighterwallet://              → freighterwallet://wc?uri=…
 *   freighterwallet://wc-redirect   → freighterwallet://wc-redirect?uri=…
 *   https://freighter.app/          → https://freighter.app/wc?uri=…
 *
 * A link that already carries a path keeps it. That matters: Freighter only
 * pairs from a URL containing the redirect string it was built with, so
 * rewriting a published path to a generic `/wc` would hand the user a link the
 * wallet ignores.
 */
export function formatNativeUrl(appLink: string, wcUri: string): string {
  const encoded = encodeURIComponent(wcUri);
  const at = appLink.indexOf("://");
  const scheme = (at === -1 ? appLink : appLink.slice(0, at)).replace(/[:/]+$/, "");
  const rest = at === -1 ? "" : appLink.slice(at + 3);

  // On an https link the first segment is the host, not part of the path.
  if (/^https?$/i.test(scheme)) {
    const slash = rest.indexOf("/");
    const host = slash === -1 ? rest : rest.slice(0, slash);
    const path = trim(slash === -1 ? "" : rest.slice(slash + 1));
    return `${scheme}://${host}/${withUri(path, encoded)}`;
  }
  return `${scheme}://${withUri(trim(rest), encoded)}`;
}

/** Strip the slashes that would otherwise double up when segments are joined. */
function trim(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Append `uri=…` to `path`, defaulting to WalletConnect's `wc` entry point. */
function withUri(path: string, encodedUri: string): string {
  const target = path === "" ? "wc" : path;
  return `${target}${target.includes("?") ? "&" : "?"}uri=${encodedUri}`;
}

/** The `G…` accounts a live session grants us on the active chain. */
function sessionAccounts(provider: WalletConnectProvider): string[] {
  const accounts = provider.session?.namespaces?.stellar?.accounts ?? [];
  const chain = caipChainId();
  return accounts
    .filter((account) => account.startsWith(`${chain}:`))
    .map((account) => account.slice(chain.length + 1))
    .filter(isValidStellarAddress);
}

/** Map a thrown WalletConnect error onto a {@link WalletError}. */
function walletConnectError(err: unknown, prefix: string): WalletError {
  if (err instanceof WalletError) return err;
  const code = (err as { code?: number })?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === WC_USER_REJECTED || /reject|declin|denied|cancell?ed/i.test(message)) {
    return new WalletError("rejected", "You declined the request in Freighter.");
  }
  return new WalletError("failed", `${prefix}: ${message}`);
}

/**
 * Bring Freighter to the foreground before it is asked to sign. On a phone the
 * browser keeps focus after `request()` is sent, so without this the user sits
 * on a spinner with the prompt buried in another app. The link comes from the
 * session the wallet itself opened, so nothing is hardcoded.
 */
function focusWallet(provider: WalletConnectProvider): void {
  if (typeof window === "undefined" || !isMobileBrowser()) return;
  const redirect = provider.session?.peer?.metadata?.redirect;
  const link = redirect?.native || redirect?.universal;
  if (link) window.location.href = link;
}

/**
 * Every proposal the wallet hasn't answered yet, including ones whose attempt
 * already gave up. Giving up can't withdraw a proposal (the SDK's
 * `abortPairingAttempt()` is a no-op), and its URI can still reach the screen
 * after a retry has started, so the user may approve that one instead.
 *
 * Kept per provider: an approval opens a session only on the provider that
 * proposed it, so a provider replaced since (by `disconnect()`) is no help.
 */
const unansweredProposals = new WeakMap<WalletConnectProvider, Set<Promise<unknown>>>();

/** The proposals `provider` is still waiting on, created on first use. */
function proposalsOf(provider: WalletConnectProvider): Set<Promise<unknown>> {
  let proposals = unansweredProposals.get(provider);
  if (!proposals) unansweredProposals.set(provider, (proposals = new Set()));
  return proposals;
}

/** Rejects the pairing `connect()` is waiting on; null when none is. */
let abandonPairing: ((reason: WalletError) => void) | null = null;

/** True while `connect()` is waiting for the wallet to answer a pairing. */
export function pairingIsPending(): boolean {
  return abandonPairing !== null;
}

/**
 * Stop waiting for the pairing in progress: `connect()` rejects with
 * `cancelled` and the prompt closes. A no-op when nothing is pending, so the
 * dialog can call it without checking first.
 */
export function cancelPairing(): void {
  abandonPairing?.(new WalletError("cancelled", "You cancelled connecting Freighter."));
}

/** Rejects the signing request a caller is waiting on; null when none is. */
let abandonRequest: ((reason: WalletError) => void) | null = null;

/**
 * Stop waiting on Freighter, whatever for: the pairing prompt or a signature.
 * The waiting call rejects with `cancelled`. A no-op when nothing is pending.
 */
export function cancelWalletRequest(): void {
  cancelPairing();
  abandonRequest?.(new WalletError("cancelled", "You cancelled the request to Freighter."));
}

/** How long dropping a session waits for the relay before forgetting it anyway. */
export const DROP_SESSION_WAIT_MS = 2_000;

/**
 * Forget the session, telling the wallet if the relay lets us. The SDK's
 * `disconnect()` clears its session only *after* the relay answers, and the
 * relay (or the wallet behind it) is exactly what may not be there, so it gets
 * {@link DROP_SESSION_WAIT_MS} and then the session is cleared here regardless.
 * Whatever the relay does later, the next request can't go out over it.
 *
 * The goodbye goes through the sign client rather than `provider.disconnect()`.
 * The provider's own cleanup runs whenever the relay finally answers — the SDK
 * retries a publish for up to a minute, and a phone that went off to Freighter
 * meanwhile only answers once it is back — and it clears `provider.session`
 * whatever that holds by then. After a slow relay that is the session the
 * *next* pairing just opened, and the sign-in after it then has nothing to
 * send the challenge over.
 *
 * The session is deleted from the sign client's store too, so a provider built
 * later (the next page load, or after {@link retireProvider}) can't restore it.
 */
async function dropSession(provider: WalletConnectProvider): Promise<void> {
  if (!provider.session) return;
  const topic = provider.session.topic;
  const client = provider.client;
  const told = (
    client && topic
      ? client.disconnect({ topic, reason: USER_DISCONNECTED })
      : provider.disconnect()
  ).catch(() => {});
  await within(told, DROP_SESSION_WAIT_MS);
  provider.session = undefined;
  if (client && topic) {
    try {
      // Awaited: the store persists the removal asynchronously, and pairing
      // before it lands leaves the stale session for the next provider to restore.
      await client.session.delete(topic, USER_DISCONNECTED);
    } catch {
      // Already gone, because the relay answered in time.
    }
  }
}

/** Wait for `promise`, but no longer than `ms`. Never rejects. */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.catch(() => {}),
    new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))),
  ]);
  clearTimeout(timer);
}

/**
 * Wait for Freighter to answer a signing request, but not forever: give up
 * after {@link REQUEST_TIMEOUT_MS} or when the contributor cancels. Either way
 * the session is dropped, because a session Freighter didn't answer on can't be
 * trusted to carry the next request, and the retry should pair afresh.
 *
 * With `focusAfterMs`, Freighter is brought forward only if the answer is still
 * missing by then. That grace is part of the wait, so a cancel during it stops
 * the wait and Freighter is not brought forward afterwards.
 */
async function awaitAnswer<T>(
  provider: WalletConnectProvider,
  pending: Promise<T>,
  { focusAfterMs }: { focusAfterMs?: number } = {},
): Promise<T> {
  pending.catch(() => {}); // answered after we gave up: nowhere to go
  let timer: ReturnType<typeof setTimeout> | undefined;
  let giveUp: ((reason: WalletError) => void) | undefined;
  const givenUp = new Promise<never>((_, reject) => {
    giveUp = reject;
    abandonRequest = reject;
    timer = setTimeout(
      () =>
        reject(
          new WalletError(
            "timed_out",
            "Freighter didn't answer in time. Open Freighter, then try again.",
          ),
        ),
      REQUEST_TIMEOUT_MS,
    );
  });
  const focusTimer =
    focusAfterMs === undefined ? undefined : setTimeout(() => focusWallet(provider), focusAfterMs);

  try {
    return await Promise.race([pending, givenUp]);
  } catch (err) {
    // Before the session teardown below, which can take DROP_SESSION_WAIT_MS:
    // a wait that has ended must not bring Freighter forward in the meantime.
    clearTimeout(focusTimer);
    if (err instanceof WalletError && (err.code === "timed_out" || err.code === "cancelled")) {
      await dropSession(provider);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    clearTimeout(focusTimer);
    if (abandonRequest === giveUp) abandonRequest = null;
  }
}

/**
 * Make sure there is a session to send a request over, pairing if there isn't:
 * the one sign-in opened can expire, or have been dropped after an unanswered
 * request, and the SDK refuses a request with no session at all.
 */
async function ensureSession(provider: WalletConnectProvider): Promise<void> {
  if (sessionAccounts(provider).length === 0) await connect();
}

/**
 * Connect Freighter mobile and return its `G…` address.
 *
 * A live session is reused unless `fresh` is set, so a returning user isn't
 * asked to pair again for a signature. Sign-in and wallet claim pass `fresh`:
 * they exist to reach the wallet, and a session stored in this browser can be
 * one Freighter no longer holds (it outlives deploys, and the wallet can drop
 * it on its side), in which case every request over it is silently ignored.
 */
export async function connect(
  options: { fresh?: boolean } = {},
): Promise<{ address: string; wallet: "freighter" }> {
  const provider = await getProvider();

  if (options.fresh) await dropSession(provider);
  const existing = sessionAccounts(provider);
  if (existing.length > 0) return { address: existing[0], wallet: "freighter" };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let giveUp: ((reason: WalletError) => void) | undefined;
  // Registered before the proposal goes out, so the URI it produces is
  // recognized as this attempt's (see publishPairingFor).
  const givenUp = new Promise<never>((_, reject) => {
    giveUp = reject;
    abandonPairing = reject;
    timer = setTimeout(
      () =>
        reject(
          new WalletError(
            "timed_out",
            "Freighter didn't answer in time. Open Freighter, then try again.",
          ),
        ),
      PAIRING_TIMEOUT_MS,
    );
  });

  const approval = provider.connect({
    namespaces: {
      stellar: {
        chains: [caipChainId()],
        methods: [...STELLAR_METHODS],
        events: [...STELLAR_EVENTS],
      },
    },
  });
  const proposals = proposalsOf(provider);
  proposals.add(approval);
  const answered = () => void proposals.delete(approval);
  approval.then(answered, answered);

  // Approving *any* of this provider's outstanding proposals opens a session
  // on it, which is all this attempt needs. Only this attempt's own
  // proposal can fail it: an older one failing says nothing about this one.
  const approvedAny = new Promise<void>((resolve) => {
    for (const proposal of proposals) proposal.then(() => resolve(), () => {});
  });

  try {
    await Promise.race([approval, approvedAny, givenUp]);
  } catch (err) {
    throw walletConnectError(err, "Freighter connection failed");
  } finally {
    clearTimeout(timer);
    // Only clear our own: a newer attempt may already have taken the slot.
    if (abandonPairing === giveUp) abandonPairing = null;
    publishPairing(null);
  }

  const accounts = sessionAccounts(provider);
  if (accounts.length === 0) {
    throw new WalletError(
      "wrong_network",
      `Freighter approved the connection but not on ${caipChainId()}. Switch the network in Freighter, then try again.`,
    );
  }
  return { address: accounts[0], wallet: "freighter" };
}

/**
 * Prove ownership of `expectedAddress` with a SEP-53 signature from Freighter
 * mobile.
 *
 * The wallet answers `{ signature }` and nothing else, so unlike the extension
 * path there is no `signerAddress` to compare. We verify the signature against
 * `expectedAddress` ourselves — which is what the server does anyway, and is a
 * real check rather than a self-report the wallet could get wrong.
 */
export async function signOwnership(
  message: string,
  expectedAddress: string,
): Promise<StellarSignedMessage> {
  const provider = await getProvider();
  await ensureSession(provider);
  assertSessionAccount(provider, expectedAddress);

  let result: { signature?: unknown };
  try {
    // Send first, then foreground the wallet: the request is on its way over
    // the relay by the time Freighter comes up, so the prompt is already there.
    const pending = requestMessageSignature(provider, message);
    focusWallet(provider);
    result = await awaitAnswer(provider, pending);
  } catch (err) {
    throw walletConnectError(err, "Freighter signing failed");
  }
  return readProof(result, message, expectedAddress);
}

/** Refuse before asking, when the session is for some other account. */
function assertSessionAccount(provider: WalletConnectProvider, expectedAddress: string): void {
  const accounts = sessionAccounts(provider);
  if (accounts.length > 0 && !accounts.includes(expectedAddress)) {
    throw new WalletError(
      "wrong_account",
      `Freighter is connected as ${accounts[0]}, not ${expectedAddress}. Switch accounts in Freighter, then try again.`,
    );
  }
}

function requestMessageSignature(
  provider: WalletConnectProvider,
  message: string,
): Promise<{ signature?: unknown }> {
  return provider.request({ method: "stellar_signMessage", params: { message } }, caipChainId());
}

function requestTransactionSignature(
  provider: WalletConnectProvider,
  xdr: string,
): Promise<{ signedXDR?: unknown }> {
  return provider.request({ method: "stellar_signXDR", params: { xdr } }, caipChainId());
}

/**
 * The proof in Freighter's `stellar_signMessage` answer, verified against
 * `expectedAddress` since the wallet reports no signer of its own.
 */
function readProof(
  result: { signature?: unknown },
  message: string,
  expectedAddress: string,
): StellarSignedMessage {
  const signature = result?.signature;
  if (typeof signature !== "string" || signature.length === 0) {
    throw new WalletError("rejected", "Freighter returned no signature (signing was rejected).");
  }
  if (!verify(expectedAddress, message, signature)) {
    throw new WalletError(
      "wrong_account",
      `That signature isn't from ${expectedAddress}. Switch to the account you connected, then try again.`,
    );
  }

  return { address: expectedAddress, signature, scheme: "sep53", wallet: "freighter" };
}

/**
 * Co-sign a server-built transaction envelope with Freighter mobile, for the
 * sponsored-trustline flow. Returns the signed XDR.
 *
 * The wallet answers `{ signedXDR }` with no signer address, so the envelope is
 * checked instead: it must come back carrying a signature that verifies against
 * `expectedAddress` for this network's passphrase.
 */
export async function signTransaction(
  xdr: string,
  expectedAddress: string,
): Promise<string> {
  const provider = await getProvider();
  await ensureSession(provider);

  let result: { signedXDR?: unknown };
  try {
    // Sent before the app is foregrounded — see signOwnership.
    const pending = requestTransactionSignature(provider, xdr);
    focusWallet(provider);
    result = await awaitAnswer(provider, pending);
  } catch (err) {
    throw walletConnectError(err, "Freighter signing failed");
  }
  return readSignedEnvelope(result, expectedAddress);
}

/** The co-signed XDR in Freighter's `stellar_signXDR` answer, checked for `expectedAddress`'s signature. */
async function readSignedEnvelope(
  result: { signedXDR?: unknown },
  expectedAddress: string,
): Promise<string> {
  const signedXdr = result?.signedXDR;
  if (typeof signedXdr !== "string" || signedXdr.length === 0) {
    throw new WalletError("rejected", "Freighter returned no signature (signing was rejected).");
  }
  await assertSignedBy(signedXdr, expectedAddress);
  return signedXdr;
}

/**
 * How long, once the proof is in, a transaction asked for alongside it
 * ({@link signOwnershipAndTransaction}) gets to arrive before Freighter is
 * brought forward for it.
 *
 * Freighter queues the transaction right behind the message, so the contributor
 * approves both before coming back. On a phone the browser is frozen until then,
 * so both answers are waiting on the relay and arrive together. A transaction
 * still missing after this was left open in Freighter, and the contributor
 * needs taking back to it, as they would for a request of its own.
 */
export const BATCHED_ANSWER_GRACE_MS = 3_000;

/**
 * Prove ownership of `expectedAddress` and co-sign `xdr` in **one** visit to the
 * Freighter app (#170), where {@link signOwnership} then {@link signTransaction}
 * would take two.
 *
 * On a phone, every request is a trip out of the browser and back: the browser
 * is frozen while Freighter is in front, so it can't send the next request
 * until the contributor returns. Sending both before Freighter comes up puts
 * them in Freighter's queue together, and the contributor answers them back to
 * back.
 *
 * Resolves once the proof is in, so sign-in isn't held up by payout setup. The
 * transaction is collected later through `signedTransaction`, which fails the
 * way {@link signTransaction} does.
 */
export async function signOwnershipAndTransaction(
  message: string,
  xdr: string,
  expectedAddress: string,
): Promise<StellarProofAndTransaction> {
  const provider = await getProvider();
  await ensureSession(provider);
  assertSessionAccount(provider, expectedAddress);

  let result: { signature?: unknown };
  let pendingTransaction: Promise<{ signedXDR?: unknown }>;
  try {
    // The message first, so Freighter shows it first.
    const pendingMessage = requestMessageSignature(provider, message);
    pendingTransaction = requestTransactionSignature(provider, xdr);
    // Nothing may be listening yet, and sign-in may never get as far as asking.
    pendingTransaction.catch(() => {});
    focusWallet(provider);
    result = await awaitAnswer(provider, pendingMessage);
  } catch (err) {
    throw walletConnectError(err, "Freighter signing failed");
  }

  const proof = readProof(result, message, expectedAddress);
  return {
    proof,
    signedTransaction: () => collectTransaction(provider, pendingTransaction, expectedAddress),
  };
}

/**
 * The answer to a transaction request sent by {@link signOwnershipAndTransaction}.
 * Freighter is brought forward only if the answer is still missing after
 * {@link BATCHED_ANSWER_GRACE_MS}. The whole wait, grace included, is bounded
 * and cancellable like any other signature.
 */
async function collectTransaction(
  provider: WalletConnectProvider,
  pending: Promise<{ signedXDR?: unknown }>,
  expectedAddress: string,
): Promise<string> {
  let result: { signedXDR?: unknown };
  try {
    result = await awaitAnswer(provider, pending, { focusAfterMs: BATCHED_ANSWER_GRACE_MS });
  } catch (err) {
    throw walletConnectError(err, "Freighter signing failed");
  }
  return readSignedEnvelope(result, expectedAddress);
}

/**
 * Throw `wrong_account` unless `signedXdr` carries a valid signature from
 * `expectedAddress`. The platform may already have signed as sponsor (an
 * envelope offered at sign-in, #170, it signs later), so the envelope can hold
 * more than one signature, and each is checked against the transaction hash
 * until one matches.
 */
async function assertSignedBy(signedXdr: string, expectedAddress: string): Promise<void> {
  const { Keypair, TransactionBuilder } = await import("@stellar/stellar-sdk");
  let signedBy = false;
  try {
    const tx = TransactionBuilder.fromXDR(signedXdr, clientNetworkPassphrase());
    const keypair = Keypair.fromPublicKey(expectedAddress);
    const hash = tx.hash();
    signedBy = tx.signatures.some((sig) => keypair.verify(hash, sig.signature()));
  } catch (err) {
    throw new WalletError(
      "failed",
      `Freighter returned a transaction we couldn't read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!signedBy) {
    throw new WalletError(
      "wrong_account",
      `Freighter signed with a different account: the envelope carries no signature from ${expectedAddress}.`,
    );
  }
}

/**
 * Get the slow parts of the mobile path out of the way before the user taps:
 * the relay SDK download and handshake, and the registry lookup for the deep
 * link. Both are idempotent and memoized, so calling this repeatedly is free.
 *
 * The cost is deliberate and bounded: a contributor who opens the sign-in
 * screen on a phone downloads the relay bundle and holds one relay socket open
 * whether or not they go on to tap. That buys the thing the screen exists for —
 * the tap hands them to Freighter instead of starting a download. It is only
 * ever reached on the WalletConnect path, so a desktop with the extension pays
 * none of it, and a deployment with no project id never gets here at all.
 *
 * Never throws: this is a head start, and a failure here just means the real
 * attempt pays the cost and reports the error itself.
 */
export async function warmUp(): Promise<void> {
  void freighterMobileLink();
  try {
    await getProvider();
  } catch {
    // Deliberately swallowed — see above.
  }
}

/**
 * The longest sign-out waits on WalletConnect. Telling Freighter goodbye is a
 * courtesy; a sign-out that sits on "Logging out…" because the relay is slow
 * (it retries for up to a minute) is a bug.
 */
export const DISCONNECT_WAIT_MS = 3_000;

/**
 * Sign-out: drop the session and shut the relay connection down, so the next
 * sign-in starts from a new one. Never throws, and never takes longer than
 * {@link DISCONNECT_WAIT_MS}.
 *
 * Forgetting the provider isn't enough on its own. Sign-out doesn't reload the
 * page, so the old provider's sign client would stay alive on an open socket,
 * and the SDK hands every new sign client the page's existing core — relay,
 * keychain and all. Each sign-out then stacked another client on one relay,
 * every one of them handling every message Freighter sent, and a sign-in after
 * a sign-out could lose the approval or the signature to a client nobody was
 * listening to.
 */
export async function disconnect(): Promise<void> {
  const pending = providerPromise;
  // Cleared first, so a sign-in that starts while this finishes builds anew.
  providerPromise = null;
  publishPairing(null);
  if (!pending) return;
  await within(
    pending.then(retireProvider, () => {}),
    DISCONNECT_WAIT_MS,
  );
}

/**
 * Take `provider` out of service for good: drop its session, stop the SDK's
 * timers, close its relay socket, and unhook its core from the page so the next
 * provider gets a core of its own.
 */
async function retireProvider(provider: WalletConnectProvider): Promise<void> {
  const core = provider.client?.core;
  if (core) {
    // Before anything is awaited: a sign-in screen mounting right now must
    // not be handed this core.
    forgetGlobalCore(core);
    // The heartbeat is what reopens a closed socket (and runs the expirer).
    core.heartbeat.stop();
  }
  await dropSession(provider);
  await core?.relayer.transportClose().catch(() => {});
}

/**
 * The SDK keeps the page's core on `globalThis._walletConnectCore_<prefix>` and
 * hands it to every sign client created after it. Remove it (and the counter
 * behind the SDK's "already initialized" warning) so the next one starts clean.
 */
function forgetGlobalCore(core: object): void {
  const slots = globalThis as unknown as Record<string, unknown>;
  for (const key of Object.keys(slots)) {
    if (key.startsWith("_walletConnectCore_") && slots[key] === core) {
      delete slots[key];
      delete slots[`${key}_count`];
    }
  }
}

/**
 * Publish a pairing exactly as a live relay would. For tests: the UI's whole
 * job is reacting to this, and driving it through the real subscription is the
 * only way to test that without standing up a relay.
 */
export function emitPairingForTest(pairing: WalletConnectPairing | null): void {
  publishPairing(pairing);
}

/** Reset the memoized registry lookup. For tests. */
export function resetMobileLinkCache(): void {
  cachedMobileLink = undefined;
}

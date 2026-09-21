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
import { WalletError, type StellarSignedMessage } from "./wallet-errors";

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
    namespaces?: Record<string, { accounts?: string[] }>;
    peer?: { metadata?: { redirect?: { native?: string; universal?: string } } };
  };
  connect(opts: {
    namespaces: Record<string, { chains: string[]; methods: string[]; events: string[] }>;
  }): Promise<unknown>;
  request<T>(args: { method: string; params?: unknown }, chain?: string): Promise<T>;
  disconnect(): Promise<void>;
  on(event: string, listener: (...args: never[]) => void): void;
}

let providerPromise: Promise<WalletConnectProvider> | null = null;

/** Replace the cached provider. Tests inject a stand-in; `null` clears it. */
export function setWalletConnectProvider(provider: WalletConnectProvider | null): void {
  providerPromise = provider ? Promise.resolve(provider) : null;
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

    // The relay hands us the pairing URI asynchronously, after `connect()` has
    // already been called, so the UI learns about it through the subscription.
    provider.on("display_uri", ((uri: string) => {
      void publishPairingFor(uri);
    }) as (...args: never[]) => void);

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
 */
async function publishPairingFor(uri: string): Promise<void> {
  publishPairing({ uri, deepLink: null, linkIsExact: false });
  const link = await freighterMobileLink();
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
 * Connect Freighter mobile and return its `G…` address, reusing a live session
 * when there is one so a returning user isn't asked to pair again.
 */
export async function connect(): Promise<{ address: string; wallet: "freighter" }> {
  const provider = await getProvider();

  const existing = sessionAccounts(provider);
  if (existing.length > 0) return { address: existing[0], wallet: "freighter" };

  try {
    await provider.connect({
      namespaces: {
        stellar: {
          chains: [caipChainId()],
          methods: [...STELLAR_METHODS],
          events: [...STELLAR_EVENTS],
        },
      },
    });
  } catch (err) {
    throw walletConnectError(err, "Freighter connection failed");
  } finally {
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

  const accounts = sessionAccounts(provider);
  if (accounts.length > 0 && !accounts.includes(expectedAddress)) {
    throw new WalletError(
      "wrong_account",
      `Freighter is connected as ${accounts[0]}, not ${expectedAddress}. Switch accounts in Freighter, then try again.`,
    );
  }

  let result: { signature?: unknown };
  try {
    // Send first, then foreground the wallet: the request is on its way over
    // the relay by the time Freighter comes up, so the prompt is already there.
    const pending = provider.request<{ signature?: unknown }>(
      { method: "stellar_signMessage", params: { message } },
      caipChainId(),
    );
    focusWallet(provider);
    result = await pending;
  } catch (err) {
    throw walletConnectError(err, "Freighter signing failed");
  }

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

  let result: { signedXDR?: unknown };
  try {
    // Sent before the app is foregrounded — see signOwnership.
    const pending = provider.request<{ signedXDR?: unknown }>(
      { method: "stellar_signXDR", params: { xdr } },
      caipChainId(),
    );
    focusWallet(provider);
    result = await pending;
  } catch (err) {
    throw walletConnectError(err, "Freighter signing failed");
  }

  const signedXdr = result?.signedXDR;
  if (typeof signedXdr !== "string" || signedXdr.length === 0) {
    throw new WalletError("rejected", "Freighter returned no signature (signing was rejected).");
  }
  await assertSignedBy(signedXdr, expectedAddress);
  return signedXdr;
}

/**
 * Throw `wrong_account` unless `signedXdr` carries a valid signature from
 * `expectedAddress`. The platform has already signed as sponsor, so the
 * envelope holds more than one signature and each is checked against the
 * transaction hash until one matches.
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

/** Drop the current session so the next connect pairs afresh. Never throws. */
export async function disconnect(): Promise<void> {
  if (!providerPromise) return;
  try {
    const provider = await providerPromise;
    if (provider.session) await provider.disconnect();
  } catch {
    // A session the relay already dropped is exactly the state we wanted.
  } finally {
    providerPromise = null;
    publishPairing(null);
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

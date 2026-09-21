// Prove a WalletConnect project id actually works before it ships — and settle,
// on real infrastructure, the one thing the Freighter-mobile path can't verify
// from source: whether Freighter is listed in the WalletConnect registry, and
// what deep link it publishes there.
//
// Run it once after pasting the id into `.env.local`, and again against the
// deployed value if the mobile path ever stops handing people to the app.
//
// Usage:
//   NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=… pnpm walletconnect:verify
//
// or, with the id already in `.env.local`:
//   pnpm walletconnect:verify
//
// Three checks, in the order a contributor's tap hits them:
//
//   1. the id is shaped like a real project id — catches a half-pasted value
//      before anything slower is attempted;
//   2. the **relay** accepts it — this is the check that matters, because an
//      id the relay refuses means no pairing is ever created and the mobile
//      path is dead however good the rest of the wiring is;
//   3. the **registry** knows Freighter — the deep link comes from there, and
//      a miss is survivable (wallet-connect.ts falls back to the scheme read
//      off Freighter's own build config) but worth knowing about, because the
//      fallback opens the app without guaranteeing the pairing lands.
//
// Exit code is 1 only when the id itself is unusable. A registry miss prints a
// warning and exits 0: the app is designed to survive it.
//
// Note on networks: this talks to `relay.walletconnect.org` and
// `explorer-api.walletconnect.com`. Some sandboxes and corporate proxies block
// both — a "could not reach" result there says nothing about the id, and the
// script says so rather than failing the id for it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatNativeUrl } from "../lib/stellar/wallet-connect";

const RELAY_URL = "wss://relay.walletconnect.org";
const EXPLORER_API = "https://explorer-api.walletconnect.com/v3/wallets";
const TIMEOUT_MS = 15_000;

/** A pairing URI shaped like a real one, so the printed link is the real thing. */
const SAMPLE_URI =
  "wc:0000000000000000000000000000000000000000000000000000000000000000@2?relay-protocol=irn&symKey=0000000000000000000000000000000000000000000000000000000000000000";

const log = (...a: unknown[]) => console.log(...a);
const ok = (m: string) => log(`  \u001b[32m✓\u001b[0m ${m}`);
const warn = (m: string) => log(`  \u001b[33m!\u001b[0m ${m}`);
const bad = (m: string) => log(`  \u001b[31m✗\u001b[0m ${m}`);

/**
 * The project id from the environment, falling back to `.env.local` so the
 * usual case is a bare `pnpm walletconnect:verify`. Deliberately does not read
 * `.env.local.example`, whose value is a placeholder.
 */
function resolveProjectId(): string | undefined {
  const fromEnv = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim();
  if (fromEnv) return fromEnv;
  try {
    const file = readFileSync(path.resolve(__dirname, "..", ".env.local"), "utf8");
    const line = file
      .split("\n")
      .find((l) => /^\s*NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID\s*=/.test(l));
    return line?.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "") || undefined;
  } catch {
    return undefined;
  }
}

/** Reown project ids are 32 lowercase hex characters. */
function checkShape(projectId: string): boolean {
  if (/^[0-9a-f]{32}$/.test(projectId)) {
    ok(`looks like a project id (${projectId.slice(0, 6)}…${projectId.slice(-4)})`);
    return true;
  }
  bad(
    `"${projectId}" is not shaped like a Reown project id (expected 32 lowercase hex characters).`,
  );
  log("    Copy it from the project's page at https://dashboard.reown.com — it is");
  log("    the 'Project ID' field, not the project name and not an API key.");
  return false;
}

type RelayResult = "accepted" | "refused" | "unreachable";

/**
 * Can this machine reach WalletConnect at all?
 *
 * This has to be asked *before* the relay verdict is believed. A refused
 * websocket upgrade and a proxy that blocks the host are indistinguishable
 * through the WebSocket API — both surface as an error and a 1006 close, with
 * no HTTP status to read — so without this probe a blocked network gets
 * reported as "your project id is wrong", which is both false and the kind of
 * wrong answer that sends someone off regenerating a perfectly good id.
 *
 * Any response counts, including a 4xx: the question is reachability, not
 * whether the endpoint likes an unauthenticated GET.
 */
async function isWalletConnectReachable(): Promise<boolean> {
  for (const url of [
    "https://explorer-api.walletconnect.com",
    RELAY_URL.replace("wss://", "https://"),
  ]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      // A blocking proxy answers *for* the host rather than failing to connect,
      // so "we got a response" is not the same as "we reached WalletConnect".
      // Sandboxes and corporate proxies announce themselves in the body of a
      // 403; that is the tell, and without it their refusal gets misread as the
      // relay's.
      if (res.status === 403) {
        const body = await res.text().catch(() => "");
        if (/allowlist|egress|blocked|proxy|forbidden by/i.test(body)) continue;
      }
      return true;
    } catch {
      // Try the next host before concluding anything.
    }
  }
  return false;
}

/**
 * Open a relay socket exactly as the browser will. The relay authenticates the
 * project id during the websocket upgrade, so a bad id fails here and a good
 * one opens — which is the whole question.
 *
 * Only meaningful once {@link isWalletConnectReachable} says yes; see there.
 */
async function checkRelay(projectId: string): Promise<RelayResult> {
  const url = `${RELAY_URL}/?projectId=${encodeURIComponent(projectId)}&protocol=wc&version=2`;
  return new Promise<RelayResult>((resolve) => {
    let settled = false;
    const done = (r: RelayResult) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // Already closing; nothing to do.
      }
      resolve(r);
    };

    const socket = new WebSocket(url);
    const timer = setTimeout(() => done("unreachable"), TIMEOUT_MS);

    socket.onopen = () => {
      clearTimeout(timer);
      done("accepted");
    };
    // The relay rejects a bad id by refusing the upgrade, which surfaces here as
    // a close/error rather than a readable HTTP status.
    socket.onclose = (event: CloseEvent) => {
      clearTimeout(timer);
      // 1006 is an abnormal close with no handshake — what a blocked network
      // and a refused upgrade both look like from inside the browser API.
      done(event.code === 1006 ? "unreachable" : "refused");
    };
    socket.onerror = () => {
      clearTimeout(timer);
      done("refused");
    };
  });
}

interface RegistryEntry {
  name: string;
  native?: string;
  universal?: string;
}

/** Ask the registry what it publishes for Freighter. */
async function lookupFreighter(projectId: string): Promise<RegistryEntry | null | "unreachable"> {
  try {
    const res = await fetch(
      `${EXPLORER_API}?projectId=${encodeURIComponent(projectId)}&search=freighter&entries=5&page=1`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) return res.status === 401 || res.status === 403 ? null : "unreachable";
    const body = (await res.json()) as {
      listings?: Record<string, { name?: string; mobile?: { native?: string; universal?: string } }>;
    };
    for (const listing of Object.values(body.listings ?? {})) {
      if (!/freighter/i.test(listing.name ?? "")) continue;
      return {
        name: listing.name ?? "Freighter",
        native: listing.mobile?.native || undefined,
        universal: listing.mobile?.universal || undefined,
      };
    }
    return null;
  } catch {
    return "unreachable";
  }
}

async function main() {
  log("\nWalletConnect / Freighter mobile — preflight\n");

  const projectId = resolveProjectId();
  if (!projectId) {
    bad("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set.");
    log("\n  Without it the site stays extension-only: a contributor on a phone");
    log("  still gets 'install the browser extension', which no phone can do.\n");
    log("  1. Sign in at https://dashboard.reown.com (free).");
    log("  2. Create a project — type 'AppKit', any name.");
    log("  3. Copy its Project ID.");
    log("  4. Add every origin the site is served from to the project's");
    log("     allowed domains, including localhost for development.");
    log("  5. Put it in .env.local, and in the web service's variables:");
    log("        NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=…");
    log("     It is inlined at build time, so a deployment needs a rebuild.\n");
    process.exitCode = 1;
    return;
  }

  log("Project id");
  if (!checkShape(projectId)) {
    process.exitCode = 1;
    return;
  }

  log("\nRelay (this is the one that decides whether pairing works at all)");
  // A blocked network can't tell a bad id from a good one, so establish
  // reachability before reporting any verdict about the id itself.
  const reachable = await isWalletConnectReachable();
  const relay = reachable ? await checkRelay(projectId) : "unreachable";

  if (relay === "accepted") {
    ok("the relay accepted this project id — pairings can be created");
  } else if (relay === "refused") {
    bad("the relay refused this project id");
    log("    Either the id is wrong, or the origin this runs from is not in the");
    log("    project's allowed domains. Check both at https://dashboard.reown.com.");
    process.exitCode = 1;
    return;
  } else {
    warn("could not reach WalletConnect from this machine");
    log("    A sandbox, VPN or corporate proxy is blocking it. This says nothing");
    log("    about the id — nothing was verified. Re-run on the machine that");
    log("    builds or serves the site, on an unrestricted network.");
    log("\n  Nothing below was checked either.\n");
    return;
  }

  log("\nRegistry (this is where the deep link into the Freighter app comes from)");
  const entry = await lookupFreighter(projectId);
  if (entry === "unreachable") {
    warn("could not reach the WalletConnect registry");
    log("    The app survives this: it falls back to freighterwallet://, the scheme");
    log("    read off Freighter's own iOS and Android build config.");
  } else if (entry === null) {
    warn("Freighter is not listed in the registry for this project id");
    log("    The app falls back to freighterwallet:// and keeps a copy-the-link");
    log("    path visible, so a phone still has a way through — but the automatic");
    log("    hand-off is a best guess rather than the wallet's published link.");
  } else {
    const link = entry.native || entry.universal;
    ok(`found "${entry.name}"`);
    if (entry.native) log(`    native:    ${entry.native}`);
    if (entry.universal) log(`    universal: ${entry.universal}`);
    if (link) {
      log("\n    A pairing will open the app with:");
      log(`      ${formatNativeUrl(link, SAMPLE_URI).slice(0, 96)}…`);
    }
  }

  log("\nReminder: the id is inlined into the browser bundle at build time, so");
  log("setting it on a running deployment does nothing until the next build.\n");
}

main().catch((err) => {
  bad(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

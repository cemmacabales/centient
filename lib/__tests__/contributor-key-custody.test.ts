import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// #30 — no contributor private key enters Centient infrastructure.
//
// A contributor proves an address by signing in Freighter, and co-signs their
// sponsorship there too; the browser and the server only ever see public keys,
// signatures and signed envelopes. This pins that down for every module on the
// first-connect path, client and server: none reads, parses, builds or asks for
// a secret seed. Payout-account keys (the platform's own) live elsewhere and are
// guarded by `lib/stellar/key-custody.ts`.

const ROOT = path.resolve(__dirname, "../..");

const CLIENT = [
  "app/page.tsx",
  "components/LoginScreen.tsx",
  "components/AccountAuthScreen.tsx",
  "components/WalletSignIn.tsx",
  "components/WalletClaim.tsx",
  "components/PayoutSetup.tsx",
  "components/AccountSheet.tsx",
  "lib/stellar/wallet.ts",
  "lib/stellar/wallet-sign-in.ts",
  "lib/stellar/wallet-claim.ts",
  "lib/stellar/payout-setup.ts",
];

const SERVER = [
  "app/api/auth/wallet/challenge/route.ts",
  "app/api/auth/wallet/verify/route.ts",
  "app/api/auth/login/route.ts",
  "app/api/auth/me/route.ts",
  "app/api/me/wallet/route.ts",
  "app/api/me/wallet/sponsor/route.ts",
  "app/api/me/withdraw/route.ts",
  "lib/stellar/auth-challenge.ts",
];

/** Ways a Stellar secret seed is handled in code, or asked for in a UI. */
const SECRET_HANDLING: Array<[string, RegExp]> = [
  ["Keypair.fromSecret", /Keypair\s*\.\s*fromSecret/],
  ["Keypair.fromRawEd25519Seed", /fromRawEd25519Seed/],
  [".secret() / .rawSecretKey()", /\.(secret|rawSecretKey)\s*\(/],
  ["StrKey secret-seed codecs", /StrKey\s*\.\s*(decode|encode|isValid)Ed25519SecretSeed/],
  ["a secret-key field", /\b(secretKey|secret_key|privateKey|private_key|seedPhrase|mnemonic)\b/i],
  ["a literal secret seed", /\bS[A-Z2-7]{55}\b/],
];

const source = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

describe("contributor key custody on the first-connect path (#30)", () => {
  it.each([...CLIENT, ...SERVER])("%s handles no secret seed", (file) => {
    const text = source(file);
    for (const [label, pattern] of SECRET_HANDLING) {
      expect(pattern.test(text), `${file} matches ${label}`).toBe(false);
    }
  });

  it("signs only through Freighter: every signature is made in the wallet, not in Centient code", () => {
    const wallet = source("lib/stellar/wallet.ts");
    expect(wallet).toMatch(/import\("@stellar\/freighter-api"\)/);
    for (const call of ["signMessage", "signTransaction"]) {
      expect(wallet).toContain(call);
    }
    // No client module on the path signs with the SDK itself.
    for (const file of CLIENT) {
      expect(/\.sign\s*\(\s*(sep53Digest|hash|tx)/.test(source(file)), `${file} signs with the SDK`).toBe(false);
    }
  });

  it("the server takes only public addresses, signatures and signed envelopes from a contributor", () => {
    // The request fields each onboarding route reads.
    expect(source("app/api/auth/wallet/verify/route.ts")).toMatch(/\{ address, nonce, signature, signerAddress \}/);
    expect(source("app/api/me/wallet/route.ts")).toMatch(/body: \{ stellarAddress\?: unknown; signature\?: unknown \}/);
    expect(source("app/api/me/wallet/sponsor/route.ts")).toMatch(/body: \{ address\?: unknown; signedXdr\?: unknown \}/);
  });
});

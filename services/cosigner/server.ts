// The independent policy co-signer, as deployed (issue #8, ADR-0001).
//
// This runs in its own Railway project: its own container, its own variables,
// its own deploy trigger, and — importantly — its own database credential. It is
// the only process that holds `STELLAR_POLICY_SIGNER_SECRET`; the application
// refuses to start if it can see that key at all.
//
// Everything that decides whether to sign lives in `lib/stellar/cosigner-*` and
// is unit-tested there. This file is deliberately thin: read the request, hand it
// to the decision, write the answer back.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { PrismaClient } from "@/app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { usdcAsset } from "@/lib/stellar/config";
import { expiringNonceStore, resolveCoSignerConfig } from "@/lib/stellar/cosigner-config";
import {
  readBroadcastVolumeSince,
  readLedgerPayout,
  type LedgerReader,
} from "@/lib/stellar/cosigner-ledger";
import { handleCoSignRequest, type CoSignerDeps } from "@/lib/stellar/cosigner-service";

/**
 * A signing request is one envelope and a short reference. Anything larger is not
 * a payout, and reading it to find that out would be the whole attack.
 */
const MAX_BODY_BYTES = 64 * 1024;

/** Read the request body, refusing anything over the cap without buffering it. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Header values arrive as string | string[]; the signed ones are always single. */
function singleValueHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name] = Array.isArray(value) ? value[0] : value;
  }
  return headers;
}

async function main(): Promise<void> {
  const config = resolveCoSignerConfig();

  // The co-signer's own connection, under a role granted SELECT and nothing else.
  // Same database instance as the application for the MVP (ADR-0001) — the
  // credential is the boundary, and it is a real one: this process cannot write.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: config.databaseUrl }),
  }) as unknown as LedgerReader;

  const deps: CoSignerDeps = {
    policy: config.policy,
    secret: config.secret,
    nonces: expiringNonceStore(),
    asset: usdcAsset(),
    capUnits: config.capUnits,
    ledger: {
      readPayout: (reference) => readLedgerPayout(prisma, reference),
      broadcastVolumeSince: (since) => readBroadcastVolumeSince(prisma, since),
    },
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        // Unauthenticated liveness only — it reveals nothing about the ledger,
        // the cap, or whether any particular payout would be signed.
        if (req.method === "GET" && req.url === "/health") {
          return send(res, 200, { status: "ok", isolation: config.isolation });
        }
        if (req.method !== "POST" || req.url !== "/cosign") {
          return send(res, 404, { error: "not found" });
        }

        const body = await readBody(req);
        const response = await handleCoSignRequest(deps, body, singleValueHeaders(req));

        // Every refusal is logged with its reason: a co-signer that silently
        // declines looks exactly like one that is down, and the difference
        // matters at three in the morning.
        if (response.status !== 200) {
          console.warn(`[cosigner] refused ${response.status}:`, JSON.stringify(response.body));
        }
        return send(res, response.status, response.body);
      } catch (err) {
        console.error("[cosigner] request failed:", err);
        return send(res, 400, { error: (err as Error).message });
      }
    })();
  });

  server.listen(config.port, () => {
    console.log(
      `[cosigner] policy signer ${config.policy.publicKey()} listening on ${config.port} (isolation: ${config.isolation})`,
    );
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      console.log(`[cosigner] ${signal} — draining`);
      server.close(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  // Refusing to start is the designed response to a misconfiguration: a
  // co-signer that boots with the wrong key, the wrong cap, or the wrong
  // database credential would still hand out signatures.
  console.error("[cosigner] failed to start:", err);
  process.exit(1);
});

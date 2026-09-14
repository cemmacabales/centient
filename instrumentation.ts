import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    await assertPayoutSigningSeparation();
    await startBackgroundWorkers();
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

/**
 * Refuse to serve if this deployment can produce both payout signatures.
 *
 * The payout worker runs in this process (below), so "the app" and "the thing
 * that pays people" are the same deployment. A configuration holding both
 * COSIGNER_URL and the policy signing key has collapsed the two signing
 * boundaries into one, and that should be visible when the deployment comes up
 * rather than when the first payout is attempted. See ADR-0001.
 */
async function assertPayoutSigningSeparation() {
  const { assertAppDeploymentSeparation } = await import("./lib/stellar/payout-cosigner");
  try {
    assertAppDeploymentSeparation();
  } catch (err) {
    console.error("[instrumentation] refusing to start:", err);
    Sentry.captureException(err, { extra: { context: "payout-signing-separation" } });
    // Exiting rather than rethrowing: the deployment must fail visibly and
    // deterministically, not depend on how the framework happens to treat an
    // error thrown from instrumentation. The co-signer refuses a bad boot the
    // same way.
    await Sentry.flush(2000).catch(() => {});
    process.exit(1);
  }
}

let workersStarted = false;

// Runs the payout worker + reconciler as long-lived polling loops inside the
// web server process, so a queued withdrawal is paid out without a separate
// worker deployment. Jobs are claimed with FOR UPDATE SKIP LOCKED, so running
// one loop per instance stays correct even when the app is scaled out.
//
// Opt out with RUN_WORKERS=false when running a dedicated worker process
// (e.g. `pnpm payout` / `pnpm reconciler` as their own Railway service).
async function startBackgroundWorkers() {
  if (process.env.RUN_WORKERS === "false") {
    console.log("[instrumentation] RUN_WORKERS=false — in-process workers disabled");
    return;
  }
  if (workersStarted) return;
  workersStarted = true;

  try {
    const { runWorkerLoop } = await import("./lib/payout-worker");
    const { runReconcilerLoop } = await import("./lib/reconciler");

    void runWorkerLoop().catch((err) => {
      console.error("[instrumentation] payout worker loop crashed:", err);
      Sentry.captureException(err, { extra: { context: "in-process-payout-worker" } });
    });
    void runReconcilerLoop().catch((err) => {
      console.error("[instrumentation] reconciler loop crashed:", err);
      Sentry.captureException(err, { extra: { context: "in-process-reconciler" } });
    });

    console.log("[instrumentation] in-process payout worker + reconciler started");
  } catch (err) {
    console.error("[instrumentation] failed to start background workers:", err);
    Sentry.captureException(err, { extra: { context: "start-background-workers" } });
  }
}

export const onRequestError = Sentry.captureRequestError;

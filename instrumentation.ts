import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    await startBackgroundWorkers();
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
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

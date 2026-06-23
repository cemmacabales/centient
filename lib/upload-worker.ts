import "dotenv/config";
import * as Sentry from "@sentry/nextjs";
import { randomUUID } from "crypto";
import prisma from "./prisma";
import { parseCSV, type TaskRow } from "./csv-parser";

const CHUNK_SIZE = 500;
const STALE_PROCESSING_MS = 60_000;
const POLL_IDLE_MS = 1_000;
const HEARTBEAT_EVERY_MS = 5_000;
const ERROR_SAMPLE_LIMIT = 10;

let shouldStop = false;
let currentJobId: string | null = null;

export async function claimNextJob(): Promise<{ id: string } | null> {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);

  const claimed = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "upload_jobs"
    SET "status" = 'processing',
        "startedAt" = COALESCE("startedAt", NOW()),
        "workerHeartbeatAt" = NOW(),
        "updatedAt" = NOW()
    WHERE "id" = (
      SELECT "id" FROM "upload_jobs"
      WHERE "status" = 'queued'
         OR ("status" = 'processing' AND "workerHeartbeatAt" < ${staleBefore})
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id"
  `;

  return claimed[0] ?? null;
}

export async function processJob(jobId: string): Promise<void> {
  currentJobId = jobId;

  const job = await prisma.uploadJob.findUnique({ where: { id: jobId } });
  if (!job) {
    console.error(`[upload-worker] job ${jobId} not found`);
    Sentry.captureMessage(`[upload-worker] job ${jobId} not found`, { level: "error" });
    return;
  }

  console.log(
    `[upload-worker] starting job ${jobId} campaign=${job.campaignId} totalRows=${job.totalRows}`
  );

  let parseErrorCount = 0;
  let parseErrorSamples: string[] = [];
  let rows: TaskRow[] = [];

  try {
    const parsed = parseCSV(job.rawText);
    rows = parsed.rows;
    parseErrorCount = parsed.errors.length;
    parseErrorSamples = parsed.errors.slice(0, ERROR_SAMPLE_LIMIT);

    if (rows.length === 0) {
      await prisma.uploadJob.update({
        where: { id: jobId },
        data: {
          status: "done",
          completedAt: new Date(),
          processedRows: 0,
          upsertedRows: 0,
          skippedRows: parseErrorCount,
          errorRows: parseErrorCount,
          chunksCommitted: 0,
          chunksTotal: 0,
          errorSamples: parseErrorSamples,
        },
      });

      await prisma.campaign.update({
        where: { id: job.campaignId },
        data: { csvFileName: job.fileName },
      });

      await writeAudit(job.adminUserId, "tasks.upload.completed", "campaign", job.campaignId, {
        jobId,
        totalRows: 0,
        upsertedRows: 0,
        skippedRows: parseErrorCount,
        errorRows: parseErrorCount,
      });

      console.log(`[upload-worker] job ${jobId} done (no rows after parse)`);
      return;
    }

    const campaign = await prisma.campaign.findUnique({
      where: { id: job.campaignId },
      select: { defaultResponseTarget: true },
    });

    if (!campaign) {
      throw new Error(`Campaign ${job.campaignId} not found while processing job ${jobId}`);
    }

    const upsertArgs = rows.map((row) => ({
      where: {
        campaignId_prompt: {
          campaignId: job.campaignId,
          prompt: row.prompt,
        },
      },
      update: {
        responseA: row.responseA,
        responseB: row.responseB,
        responseTarget: row.responseTarget ?? campaign.defaultResponseTarget,
        category: row.category ?? null,
        isGold: false,
        goldAnswer: null,
      },
      create: {
        id: randomUUID(),
        campaignId: job.campaignId,
        prompt: row.prompt,
        responseA: row.responseA,
        responseB: row.responseB,
        responseTarget: row.responseTarget ?? campaign.defaultResponseTarget,
        category: row.category ?? null,
        isGold: false,
        goldAnswer: null,
      },
    }));

    const chunksTotal = Math.ceil(upsertArgs.length / CHUNK_SIZE);
    let processedRows = 0;
    let upsertedRows = 0;
    let chunksCommitted = 0;
    let lastHeartbeat = Date.now();

    for (let i = 0; i < upsertArgs.length; i += CHUNK_SIZE) {
      if (shouldStop) {
        console.log(`[upload-worker] job ${jobId} interrupted by shutdown signal`);
        return;
      }

      const chunk = upsertArgs.slice(i, i + CHUNK_SIZE);

      await prisma.$transaction(
        async (tx) => {
          await Promise.all(chunk.map((args) => tx.task.upsert(args)));
        },
        { timeout: 30_000 }
      );

      processedRows += chunk.length;
      upsertedRows += chunk.length;
      chunksCommitted++;

      const now = Date.now();
      if (now - lastHeartbeat >= HEARTBEAT_EVERY_MS || chunksCommitted === chunksTotal) {
        await prisma.uploadJob.update({
          where: { id: jobId },
          data: {
            processedRows,
            upsertedRows,
            chunksCommitted,
            chunksTotal,
            workerHeartbeatAt: new Date(),
            updatedAt: new Date(),
          },
        });
        lastHeartbeat = now;
      }
    }

    await prisma.uploadJob.update({
      where: { id: jobId },
      data: {
        status: "done",
        completedAt: new Date(),
        processedRows,
        upsertedRows,
        skippedRows: parseErrorCount,
        errorRows: parseErrorCount,
        chunksCommitted,
        chunksTotal,
        errorSamples: parseErrorSamples,
        workerHeartbeatAt: new Date(),
      },
    });

    await prisma.campaign.update({
      where: { id: job.campaignId },
      data: { csvFileName: job.fileName },
    });

    await writeAudit(job.adminUserId, "tasks.upload.completed", "campaign", job.campaignId, {
      jobId,
      totalRows: job.totalRows,
      upsertedRows,
      skippedRows: parseErrorCount,
      errorRows: parseErrorCount,
    });

    console.log(
      `[upload-worker] job ${jobId} done committed=${chunksCommitted}/${chunksTotal} upserted=${upsertedRows} parseErrors=${parseErrorCount}`
    );
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.error(`[upload-worker] job ${jobId} failed:`, message);
    Sentry.captureException(err, {
      extra: { jobId },
    });

    await prisma.uploadJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        completedAt: new Date(),
        lastError: message,
        errorSamples: parseErrorSamples,
      },
    });

    await writeAudit(job.adminUserId, "tasks.upload.failed", "campaign", job.campaignId, {
      jobId,
      totalRows: job.totalRows,
      lastError: message,
    });
  } finally {
    currentJobId = null;
  }
}

export async function runWorkerLoop(): Promise<void> {
  console.log("[upload-worker] starting loop");

  while (!shouldStop) {
    try {
      const claimed = await claimNextJob();
      if (!claimed) {
        await sleep(POLL_IDLE_MS);
        continue;
      }
      await processJob(claimed.id);
    } catch (err) {
      console.error("[upload-worker] loop error:", err);
      Sentry.captureException(err, {
        extra: { context: "worker-loop" },
      });
      await sleep(POLL_IDLE_MS);
    }
  }

  console.log("[upload-worker] loop stopped");
}

export function stopWorker(): void {
  shouldStop = true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeAudit(
  adminUserId: string,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        adminUserId,
        action,
        targetType,
        targetId,
        metadata: metadata as any,
      },
    });
  } catch (err) {
    console.error(`[upload-worker] failed to write audit ${action}:`, err);
    Sentry.captureException(err, {
      extra: { action, targetId },
    });
  }
}

function installSignalHandlers() {
  const handler = (signal: string) => {
    console.log(`[upload-worker] received ${signal}, finishing in-flight job then exiting`);
    shouldStop = true;
    if (currentJobId) {
      console.log(`[upload-worker] in-flight job ${currentJobId} will commit current chunk then exit`);
    }
  };
  process.on("SIGTERM", () => handler("SIGTERM"));
  process.on("SIGINT", () => handler("SIGINT"));
}

const isEntrypoint = require.main === module;
if (isEntrypoint) {
  installSignalHandlers();
  runWorkerLoop().catch((err) => {
    console.error("[upload-worker] fatal:", err);
    Sentry.captureException(err, {
      extra: { context: "worker-fatal" },
    });
    process.exit(1);
  });
}

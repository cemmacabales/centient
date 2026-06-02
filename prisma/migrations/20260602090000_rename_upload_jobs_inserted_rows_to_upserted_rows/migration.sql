-- Rename "insertedRows" to "upsertedRows" to reflect that the worker
-- performs prisma.task.upsert (create or update on the unique
-- campaignId_prompt key) rather than a pure insert. The counter tracks
-- rows processed, not net-new rows.

ALTER TABLE "upload_jobs" RENAME COLUMN "insertedRows" TO "upsertedRows";

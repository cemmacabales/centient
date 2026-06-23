# CSV Ingestion Fix + Actionable Schema Validation (Issue #245)

**Date:** 2026-06-23
**Branch:** `fix/245-csv-ingestion-processing-and-validation`
**Issue:** #245 — CSV upload hangs at "Queued for processing · 0/24 · 0 upserted"; no rows ever import.

## Problem

`POST /api/admin/campaigns/[id]/upload` parses + validates the CSV, creates an
`UploadJob(status: "queued")`, and returns `202`. The only consumer of queued jobs is the
standalone process `lib/upload-worker.ts` (`pnpm worker`). The Railway deployment
(`railway.json`) only builds and serves the Next.js web app — it never runs that worker.
So queued jobs are never claimed and the upload appears to hang forever.

Secondary problem: when a user uploads a CSV with the wrong schema (missing columns,
wrong delimiter, BOM from Excel, empty file), the feedback is vague ("Upload parsed 0
rows. 1 row(s) skipped.") and does not tell the user what to fix.

## Part 1 — Process queued jobs in-process

Trigger processing inside the web server immediately after responding `202`, using
Next.js `after()`. This keeps the existing progress-polling UI, heartbeat, retry, and
`errorSamples` machinery intact and requires no separate worker service.

- Add `claimJob(jobId)` to `lib/upload-worker.ts`: an atomic conditional update
  (`WHERE id = jobId AND (status = 'queued' OR stale processing) → 'processing'`) that
  returns whether this caller won the claim. Mirrors `claimNextJob` but targets one id.
- In the upload route, after creating the job:
  `after(async () => { if (await claimJob(job.id)) await processJob(job.id); });`
- Apply the same `after()` claim+process trigger to the retry route so "Retry" works.
- The standalone worker remains valid as a fallback / stale-job reclaimer. The atomic
  claim prevents double-processing; task upserts are idempotent regardless.

## Part 2 — Actionable schema validation

All schema-level checks live in `lib/csv-parser.ts` (pure, unit-testable, shared by route
and worker). `parseCSV` returns an additional field:

```ts
type SchemaError = { code: string; message: string };
parseCSV(text): { rows: TaskRow[]; errors: string[]; schemaError: SchemaError | null }
```

When `schemaError` is set, `rows` is empty and the message is also pushed into `errors`
(backward-compatible). Checks run in this order on the raw text:

1. **Strip UTF-8 BOM** (`﻿`) from the start before header parsing — fixes Excel
   exports where `﻿prompt` fails to match `prompt`.
2. `not_csv` — header line contains a NUL byte (binary/non-text file).
   "This doesn't look like a text CSV file. Export your data as CSV (UTF-8) and try again."
3. `empty_file` — no non-empty lines. "The file is empty."
4. `no_data_rows` — header present but no data rows. "The file has a header row but no
   data rows. Add at least one row below the header."
5. `wrong_delimiter` — header splits to 1 field on comma but ≥3 on `;` or tab.
   "This looks like a `<delim>`-separated file. Re-export it as a comma-separated CSV."
6. `missing_columns` — required columns `prompt`, `responseA`, `responseB`. Reports which
   are missing and which headers were found: "Missing required column(s): responseB.
   Columns found: prompt, response_b."

**Route:** when `schemaError` is set, return `400 { error: code, message }`. Existing
checks (non-`.csv`, `>5MB`, gold columns) are unchanged.

**Frontend (`CampaignDetail.tsx`):** the `400` handler shows the server `message` (falling
back to the existing code map, then a generic message). The upload error banner gains a
"Download template" action so users can immediately fetch a correct file. Valid-schema
files where every row is skipped still return `200`; the message now surfaces sample row
errors.

## Testing

- `components/__tests__/csv-parser.test.ts` (pure, no DB): BOM header parses; each
  missing-column case reports the right names; wrong delimiter; empty file; header-only;
  valid file still parses with `schemaError === null`.
- `lib/__tests__/upload-worker.test.ts` (DB harness, mirrors `payout-worker.test.ts`):
  `claimJob` transitions a queued job to processing and returns true; a second concurrent
  `claimJob` for the same job returns false; a `done` job is not claimed.

## Deliverable

Branch off `develop`, commits authored as `cemmacabales`, PR into `develop`.

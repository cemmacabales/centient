export type TaskRow = {
  prompt: string;
  responseA: string;
  responseB: string;
  responseTarget?: number;
  category?: string | null;
  isGold?: boolean;
  goldAnswer?: "A" | "B" | null;
};

export function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);

  return values;
}

const MAX_ROWS = 10000;

/**
 * A schema-level problem with the uploaded file (wrong columns, wrong delimiter,
 * empty, binary, etc.). Unlike per-row `errors`, a `schemaError` means the file as a
 * whole cannot be ingested, and carries a human-readable `message` telling the user
 * exactly what to fix. `code` is a stable identifier for callers/clients.
 */
export type SchemaError = { code: string; message: string };

// Columns every upload must provide. `key` is the lowercased header we match against;
// `label` is the canonical name we show users.
const REQUIRED_COLUMNS = [
  { key: "prompt", label: "prompt" },
  { key: "responsea", label: "responseA" },
  { key: "responseb", label: "responseB" },
];

/**
 * Inspect the raw file for schema-level problems before row parsing.
 * Returns the first problem found (most specific/actionable first), or null if the
 * header looks like a usable comma-separated CSV with the required columns.
 */
export function validateCSVSchema(text: string): SchemaError | null {
  // Excel and many tools prepend a UTF-8 BOM; strip it so the first header matches.
  const stripped = text.replace(/^\uFEFF/, "");

  // Binary files (e.g. an .xlsx/.zip renamed to .csv) contain NUL bytes early on.
  if (stripped.includes("\u0000")) {
    return {
      code: "not_csv",
      message:
        "This doesn't look like a text CSV file (it appears to be binary, e.g. an Excel .xlsx). Export your data as CSV (UTF-8) and try again.",
    };
  }

  const normalized = stripped.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const lines = normalized.length > 0 ? normalized.split("\n") : [];

  if (lines.every((l) => l.trim().length === 0)) {
    return { code: "empty_file", message: "The file is empty." };
  }

  const headerLine = lines[0];

  // If the header has no commas but is clearly delimited some other way, the user
  // most likely exported with the wrong delimiter (common with European locales/Excel).
  if (headerLine.split(",").length === 1) {
    const semicolons = headerLine.split(";").length;
    const tabs = headerLine.split("\t").length;
    if (semicolons >= 3 || tabs >= 3) {
      const delimiter = semicolons >= 3 ? '";" (semicolon)' : "a tab";
      return {
        code: "wrong_delimiter",
        message: `This looks like a ${delimiter}-separated file, not a comma-separated CSV. Re-export it using commas as the delimiter (the downloadable template uses commas).`,
      };
    }
  }

  const headers = headerLine.split(",").map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !headers.includes(c.key));
  if (missing.length > 0) {
    const found = headers.filter((h) => h.length > 0).join(", ") || "(none)";
    return {
      code: "missing_columns",
      message: `Missing required column(s): ${missing
        .map((c) => c.label)
        .join(", ")}. Columns found: ${found}. The first row must be a header with prompt, responseA, responseB.`,
    };
  }

  // Header is valid, but there are no data rows below it.
  if (lines.slice(1).every((l) => l.trim().length === 0)) {
    return {
      code: "no_data_rows",
      message:
        "The file has a header row but no data rows. Add at least one row of prompt/responseA/responseB below the header.",
    };
  }

  return null;
}

export function parseCSV(text: string): {
  rows: TaskRow[];
  errors: string[];
  schemaError: SchemaError | null;
} {
  const schemaError = validateCSVSchema(text);
  if (schemaError) {
    return { rows: [], errors: [], schemaError };
  }

  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .split("\n");

  const headerLine = lines[0];
  const headers = headerLine.split(",").map((h) => h.trim().toLowerCase());

  const promptIdx = headers.indexOf("prompt");
  const responseAIdx = headers.indexOf("responsea");
  const responseBIdx = headers.indexOf("responseb");
  const responseTargetIdx = headers.indexOf("responsetarget");
  const categoryIdx = headers.indexOf("category");
  const isGoldIdx = headers.indexOf("isgold");
  const goldAnswerIdx = headers.indexOf("goldanswer");

  const rows: TaskRow[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    if (rows.length >= MAX_ROWS) {
      errors.push(`Row limit of ${MAX_ROWS} reached, truncating import`);
      break;
    }

    const values = parseCSVLine(line);
    const prompt = values[promptIdx]?.trim() ?? "";
    const responseA = values[responseAIdx]?.trim() ?? "";
    const responseB = values[responseBIdx]?.trim() ?? "";
    const responseTargetStr = responseTargetIdx >= 0 ? values[responseTargetIdx]?.trim() : undefined;

    if (!prompt && !responseA && !responseB) {
      errors.push(`Row ${i + 1}: empty row`);
      continue;
    }
    if (!prompt) {
      errors.push(`Row ${i + 1}: missing prompt`);
      continue;
    }
    if (!responseA) {
      errors.push(`Row ${i + 1}: missing responseA`);
      continue;
    }
    if (!responseB) {
      errors.push(`Row ${i + 1}: missing responseB`);
      continue;
    }

    const parsedTarget = responseTargetStr ? parseInt(responseTargetStr, 10) : NaN;
    const responseTarget = Number.isFinite(parsedTarget) && parsedTarget > 0 ? parsedTarget : undefined;

    const category = categoryIdx >= 0 ? (values[categoryIdx]?.trim() || undefined) : undefined;
    const isGoldStr = isGoldIdx >= 0 ? values[isGoldIdx]?.trim().toLowerCase() : undefined;
    const isGold = isGoldStr === "true" || isGoldStr === "1" || isGoldStr === "yes";
    const goldAnswerRaw = goldAnswerIdx >= 0 ? values[goldAnswerIdx]?.trim().toUpperCase() : undefined;
    const parsedGoldAnswer = goldAnswerRaw === "A" || goldAnswerRaw === "B" ? goldAnswerRaw : undefined;
    const goldAnswer = isGold ? parsedGoldAnswer : undefined;

    if (isGold && !goldAnswer) {
      errors.push(`Row ${i + 1}: isGold is true but goldAnswer is missing or invalid (expected "A" or "B")`);
      continue;
    }

    rows.push({
      prompt,
      responseA,
      responseB,
      responseTarget,
      category,
      isGold,
      goldAnswer,
    });
  }

  return { rows, errors, schemaError: null };
}

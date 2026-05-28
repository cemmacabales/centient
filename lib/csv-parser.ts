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

export function parseCSV(text: string): { rows: TaskRow[]; errors: string[] } {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
  if (lines.length < 2) return { rows: [], errors: [] };

  const headerLine = lines[0];
  const headers = headerLine.split(",").map((h) => h.trim().toLowerCase());

  const promptIdx = headers.indexOf("prompt");
  const responseAIdx = headers.indexOf("responsea");
  const responseBIdx = headers.indexOf("responseb");
  const responseTargetIdx = headers.indexOf("responsetarget");
  const categoryIdx = headers.indexOf("category");
  const isGoldIdx = headers.indexOf("isgold");
  const goldAnswerIdx = headers.indexOf("goldanswer");

  if (promptIdx === -1 || responseAIdx === -1 || responseBIdx === -1) {
    return { rows: [], errors: ["CSV must have prompt, responseA, responseB columns"] };
  }

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

  return { rows, errors };
}

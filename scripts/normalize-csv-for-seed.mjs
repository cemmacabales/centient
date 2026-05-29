import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

/**
 * Normalize CSVs to match seed.ts TaskSeed schema:
 *   id, prompt, responseA, responseB, category, isGold, goldAnswer
 *
 * Adds a unique `id` per row: {categoryPrefix}-{lang}-{seq}
 *   - docs/campaigns/centient/question_bank.csv        → lang = "ph" (Filipino)
 *   - docs/campaigns/centient/question_bank_fallback.csv → lang = "en" (English)
 */

const FILES = [
  { input: "docs/campaigns/centient/question_bank.csv", lang: "ph" },
  { input: "docs/campaigns/centient/question_bank_fallback.csv", lang: "en" },
];

const CATEGORY_PREFIX = {
  banking: "bank",
  hr: "hr",
  ecommerce: "ecom",
  government: "gov",
  health: "health",
  social: "social",
  stem: "stem",
};

function parseCSVLine(line) {
  const values = [];
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

function escapeCSV(value) {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

for (const { input, lang } of FILES) {
  const text = readFileSync(input, "utf-8");
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");

  if (lines.length < 2) {
    console.error(`${input}: too short`);
    continue;
  }

  const headers = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
  const promptIdx    = headers.indexOf("prompt");
  const responseAIdx = headers.indexOf("responsea");
  const responseBIdx = headers.indexOf("responseb");
  const categoryIdx  = headers.indexOf("category");
  const isGoldIdx    = headers.indexOf("isgold");
  const goldAnswerIdx = headers.indexOf("goldanswer");

  if ([promptIdx, responseAIdx, responseBIdx, categoryIdx, isGoldIdx, goldAnswerIdx].some((i) => i === -1)) {
    console.error(`${input}: missing required columns`);
    continue;
  }

  const categoryCounters = {};
  const outputRows = [];
  let skippedEmpty = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const values = parseCSVLine(line);
    const prompt     = (values[promptIdx] ?? "").trim();
    const responseA  = (values[responseAIdx] ?? "").trim();
    const responseB  = (values[responseBIdx] ?? "").trim();
    const category   = (values[categoryIdx] ?? "").trim();
    const isGold     = (values[isGoldIdx] ?? "").trim();
    const goldAnswer = (values[goldAnswerIdx] ?? "").trim() || null;

    if (!prompt || !responseA || !responseB) {
      skippedEmpty++;
      continue;
    }

    const prefix = CATEGORY_PREFIX[category] || category;
    categoryCounters[prefix] = (categoryCounters[prefix] || 0) + 1;
    const seq = String(categoryCounters[prefix]).padStart(3, "0");
    const id = `${prefix}-${lang}-${seq}`;

    outputRows.push([
      id,
      prompt,
      responseA,
      responseB,
      category,
      isGold,
      goldAnswer ?? "",
    ]);
  }

  const outputLines = [
    "id,prompt,responseA,responseB,category,isGold,goldAnswer",
    ...outputRows.map((row) => row.map(escapeCSV).join(",")),
  ];

  writeFileSync(input, outputLines.join("\n") + "\n", "utf-8");

  const counts = Object.entries(categoryCounters)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  console.log(`✓ ${input}`);
  console.log(`  rows: ${outputRows.length}, skipped: ${skippedEmpty}`);
  console.log(`  categories → ${counts}`);
  console.log("");
}

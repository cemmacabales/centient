export function validateReason(text: string): boolean {
  const trimmed = text.trim();
  
  // 1. Basic length check
  if (trimmed.length < 10) return false;

  // 2. Word count check (Requires at least 3 separate words)
  const words = trimmed.split(/\s+/).filter(word => word.length > 0);
  if (words.length < 3) return false;

  // 3. Spam character detection (Fails if any single character takes up > 50% of the text)
  const charCounts: Record<string, number> = {};
  const cleanText = trimmed.toLowerCase().replace(/\s/g, '');
  
  for (const char of cleanText) {
    charCounts[char] = (charCounts[char] || 0) + 1;
  }
  
  for (const char in charCounts) {
    if (charCounts[char] / cleanText.length > 0.5) return false;
  }

  // 4. Word-Isolated Gibberish Detection
  const consonantStreakRegex = /[bcdfghjklmnpqrstvwxz]{6,}/i;
  for (const word of words) {
    if (consonantStreakRegex.test(word)) return false;
  }

  return true;
}

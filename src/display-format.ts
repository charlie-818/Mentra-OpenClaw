/** Words that must not be merged with a following suffix (e.g. "the ly" stays two tokens; "it" allowed so "it 's" -> "it's") */
const SUFFIX_MERGE_BLOCKLIST = new Set(
  "a,the,he,she,we,me,be,to,of,in,on,at,is,or,so,no,go,do,up,us,as,an,am".split(",")
);

/** Base markdown stripping and whitespace normalization used for both glasses and preview. */
export const stripMarkdownAndNormalize = (text: string): string => {
  return text
    // Insert space where asterisks sit between non-whitespace (avoid fusing words)
    .replace(/(\S)\*+(\S)/g, "$1 $2")
    // Strip markdown formatting (insert space at boundaries so words don't fuse)
    .replace(/\*+/g, "")
    .replace(/(\S)#+\s*(\S)/g, "$1 $2")
    .replace(/#+\s*/g, "")
    .replace(/(\S)"(\S)/g, "$1 $2")
    .replace(/"/g, "")
    // Strip common emoji / pictographic characters
    .replace(/[\p{Extended_Pictographic}]/gu, "")
    // Normalize whitespace (collapse multiple spaces)
    .replace(/  +/g, " ")
    // Merge word + space + contraction apostrophe so "don 't" -> "don't", "it 's" -> "it's"
    .replace(/(\w+)\s+('(?:t|s|re|ve|ll|d|m)\b)/gi, "$1$2")
    // Merge word + space + suffix into one word (calm ly -> calmly); skip blocklisted words
    .replace(
      /(\w+) (ly|ed|ing|ness|er|est|ful|less|ment|able|ible|tion|sion|ation|'s)\b/gi,
      (_, word: string, suffix: string) =>
        SUFFIX_MERGE_BLOCKLIST.has(word.toLowerCase()) ? `${word} ${suffix}` : word + suffix
    )
    // Targeted fix for Fortnite split
    .replace(/\b[Ff]ort nite\b/g, "Fortnite")
    .trim();
};

/** Format response text for readability - legacy behavior for streaming on glasses. */
export const formatResponseText = (text: string): string => {
  return stripMarkdownAndNormalize(text)
    // Add newline before numbered list items (1. 2. 3. etc) - handles mid-sentence numbers
    .replace(/([.!?])\s+(\d+\.)\s/g, "$1\n$2 ")
    .replace(/([a-z])\s+(\d+\.)\s/g, "$1\n$2 ")
    // Add newline before bullet dashes that follow text
    .replace(/([.!?a-z])\s+-\s+/gi, "$1\n- ")
    // Clean up any double newlines
    .replace(/\n\n+/g, "\n")
    .trim();
};

/** Split text into coarse paragraphs on double newlines. */
const splitParagraphs = (text: string): string[] =>
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

/** Split paragraph into sentences using simple punctuation heuristic. */
const splitSentences = (paragraph: string): string[] => {
  const matches = paragraph.match(/[^.!?]+[.!?]*/g);
  if (!matches) return [paragraph.trim()];
  return matches.map((s) => s.trim()).filter(Boolean);
};

/** High-level formatter: uppercase heading per paragraph + numbered list lines, no markdown/emojis. */
export const formatForDisplay = (raw: string): string => {
  const base = stripMarkdownAndNormalize(raw);
  if (!base) return "";

  const paragraphs = splitParagraphs(base);
  const lines: string[] = [];

  for (const para of paragraphs) {
    const sentences = splitSentences(para);
    if (sentences.length === 0) continue;

    let [first, ...rest] = sentences;
    const normalizedFirst = first.replace(/[.!?]+$/, "").trim();
    if (/^\d+$/.test(normalizedFirst) && rest.length > 0) {
      first = `${normalizedFirst}. ${rest[0]}`;
      rest = rest.slice(1);
    }

    const heading = first
      .replace(/[.!?]+$/, "")
      .trim()
      .replace(/^\d+\.\s*/, "");
    if (!heading) continue;
    lines.push(heading);

    const itemBodies: string[] = [];
    for (const sentence of rest) {
      const body = sentence
        .replace(/[.!?]+$/, "")
        .trim()
        .replace(/^\d+\.\s*/, "");
      if (!body) continue;
      if (/^\d+$/.test(body)) continue;
      itemBodies.push(body);
    }

    itemBodies.forEach((body, idx) => {
      lines.push(`${idx + 1}. ${body}`);
    });
  }

  return lines.join("\n");
};


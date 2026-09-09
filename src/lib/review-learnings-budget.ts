// UTF-8 bytes bound text size without relying on a runtime-specific tokenizer.
export const MAX_REVIEW_LEARNINGS_BYTES = 12_000;
export const MAX_REVIEW_LESSON_BYTES = 600;

export class ReviewLearningsBudgetError extends Error {}

interface Lesson { text: string; repo?: string; error?: string }

// Shared document grammar: headings, blank-separated paragraphs, and Markdown
// sibling bullets (-, *, +, or numbered). Wrapped lines belong to their lesson.
// Normalize bullets/tags for projection; preserve the operator's text on disk.
function parseLessons(content: string): Lesson[] {
  const blocks: string[] = [];
  let current = "";
  const flush = () => { if (current) blocks.push(current); current = ""; };
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) { flush(); continue; }
    if (/^\s*#{1,6}\s/.test(line)) { flush(); continue; }
    const bullet = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (bullet) { flush(); current = `- ${bullet[1].trim()}`; }
    else current += `${current ? " " : ""}${line.trim()}`;
  }
  flush();
  return blocks.map((text) => {
    const tag = text.match(/^(?:- )?\[repo:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*\]\s+(.+)$/);
    if (/\[repo:/i.test(text) && (!tag || /\[repo:/i.test(tag[2]))) {
      return { text, error: "Use a single [repo:owner/repository] tag at the start of a lesson, followed by its guidance." };
    }
    const normalized = tag ? `- [repo:${tag[1]}] ${tag[2]}` : text;
    return {
      text: normalized,
      repo: tag?.[1],
      error: Buffer.byteLength(normalized, "utf8") > MAX_REVIEW_LESSON_BYTES
        ? `Each review lesson must fit within ${MAX_REVIEW_LESSON_BYTES} UTF-8 bytes.` : undefined,
    };
  });
}

export function validateReviewLearnings(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_REVIEW_LEARNINGS_BYTES) {
    throw new ReviewLearningsBudgetError(`Review learnings must fit within ${MAX_REVIEW_LEARNINGS_BYTES} UTF-8 bytes. Shorten or remove stale lessons before saving.`);
  }
  const invalid = parseLessons(content).find((lesson) => lesson.error);
  if (invalid) throw new ReviewLearningsBudgetError(invalid.error);
}

// Apply the same grammar to legacy files. Invalid or oversized lessons stay on
// disk for curation; valid later lessons can still be injected within the budget.
export function selectReviewLearnings(content: string, repoSlug: string): string {
  const selected: string[] = [];
  let bytes = 0;
  for (const lesson of parseLessons(content)) {
    if (lesson.error || (lesson.repo && lesson.repo.toLowerCase() !== repoSlug.toLowerCase())) continue;
    const size = Buffer.byteLength(lesson.text, "utf8");
    const separator = selected.length ? 2 : 0;
    if (bytes + separator + size > MAX_REVIEW_LEARNINGS_BYTES) continue;
    selected.push(lesson.text);
    bytes += separator + size;
  }
  return selected.join("\n\n");
}

// UTF-8 bytes give a conservative, tokenizer-independent bound on text size.
// 12 KB is roughly 3K tokens for typical English; the byte limit is enforced.
export const MAX_REVIEW_LEARNINGS_BYTES = 12_000;
export const MAX_REVIEW_LESSON_BYTES = 600;

export class ReviewLearningsBudgetError extends Error {}

export function validateReviewLearnings(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_REVIEW_LEARNINGS_BYTES) {
    throw new ReviewLearningsBudgetError(`Review learnings must fit within ${MAX_REVIEW_LEARNINGS_BYTES} UTF-8 bytes. Shorten or remove stale lessons before saving.`);
  }
  for (const block of content.split(/\n(?=[-*] )/)) {
    if (/^[-*] /m.test(block) && Buffer.byteLength(block.trim(), "utf8") > MAX_REVIEW_LESSON_BYTES) {
      throw new ReviewLearningsBudgetError(`Each review lesson must fit within ${MAX_REVIEW_LESSON_BYTES} UTF-8 bytes.`);
    }
  }
}

// Apply the bound even to legacy files written before validation existed.
// Keep complete lessons: never inject a truncated instruction. Oversized legacy
// entries remain on disk for curation; a large first entry cannot starve all others.
export function selectReviewLearnings(content: string, repoSlug: string): string {
  const selected: string[] = [];
  let bytes = 0;
  for (const block of content.trim().split(/\n(?=[-*] )/)) {
    const text = block.trim();
    const tag = text.match(/^[-*] \[repo:([^\]]+)\]/);
    if (tag && tag[1] !== repoSlug) continue;
    const size = Buffer.byteLength(text, "utf8");
    if (size > MAX_REVIEW_LESSON_BYTES || !text) continue;
    const separator = selected.length ? 2 : 0;
    if (bytes + separator + size > MAX_REVIEW_LEARNINGS_BYTES) continue;
    selected.push(text);
    bytes += separator + size;
  }
  return selected.join("\n\n");
}

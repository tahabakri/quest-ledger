import type { Quest } from './config.js';

export type QuestMatch =
  | { kind: 'exact'; type: string; keyword: string }
  | { kind: 'fuzzy'; type: string; keyword: string; score: number; window: string }
  | { kind: 'none' };

interface CompiledQuest {
  type: string;
  keyword: string;
  normalized: string;
  chars: string[];
  wordCount: number;
  /** Whole-word exact matches only; never considered for typo matching. */
  strict: boolean;
}

// Scores are ratios of small integers; compare with a tolerance so 0.8 >= 0.8 holds.
const EPSILON = 1e-9;

/** Typo matching looks at the first this-many words of a caption; exact matching sees all of it. */
const MAX_FUZZY_WORDS = 100;

/**
 * Canonical form used for all matching: Unicode-normalised, lower-case, with every
 * run of punctuation, emoji and whitespace collapsed to one space. So
 * "**Share-Post** ✅" and "share post" compare equal.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim();
}

/** `text` and `phrase` are both normalised (single spaces, no punctuation), so padding with spaces marks word edges. */
function hasWholeWords(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}

/** Returns one problem per offending quest, for config validation. */
export function keywordProblems(quests: readonly Quest[]): { index: number; message: string }[] {
  const problems: { index: number; message: string }[] = [];
  const seen = new Map<string, number>();
  quests.forEach((quest, index) => {
    const normalized = normalizeText(quest.keyword);
    if (normalized === '') {
      problems.push({ index, message: 'must contain at least one letter or digit' });
      return;
    }
    const first = seen.get(normalized);
    if (first === undefined) {
      seen.set(normalized, index);
    } else {
      problems.push({ index, message: `duplicates quests[${first}] (keywords ignore case and punctuation)` });
    }
  });
  return problems;
}

/**
 * Maps a free-text caption to a quest type.
 *
 * 1. Exact: the keyword appears in the caption. Longest keyword first, so a
 *    specific keyword always beats a shorter one it shares words with. A
 *    `strict` keyword only counts as a whole word ("join" is not found in
 *    "joint") and is skipped by the typo step below.
 * 2. Fuzzy: otherwise, every run of caption words (keyword length -1/0/+1 words,
 *    to tolerate merged or split words) is scored against each keyword by
 *    Levenshtein ratio. The highest score at or above the threshold wins; ties go
 *    to the longer keyword.
 *
 * Specificity guard: when the exact hit is a keyword contained in a longer
 * keyword (e.g. "check-in" inside "daily check-in") and the caption holds the
 * exact hit plus more words that make a close typo of the longer keyword
 * ("daly check-in"), the longer one wins, flagged as fuzzy. Otherwise a typo
 * would silently downgrade the submission to the less specific quest. The exact
 * hit on its own is never evidence for a longer keyword: "day 1" stays day 1
 * even though "day 10" is one edit away.
 */
export class QuestMatcher {
  private readonly quests: CompiledQuest[];
  /** The quests typo matching may choose from (everything except `strict` ones). */
  private readonly fuzzyQuests: CompiledQuest[];

  constructor(
    quests: readonly Quest[],
    private readonly threshold: number,
  ) {
    const problems = keywordProblems(quests);
    if (problems.length > 0) {
      const detail = problems.map((p) => `quests[${p.index}].keyword ${p.message}`).join('; ');
      throw new Error(`invalid quest keywords: ${detail}`);
    }
    // Stable sort: equal lengths keep config order.
    this.quests = quests
      .map((quest) => {
        const normalized = normalizeText(quest.keyword);
        return {
          type: quest.type,
          keyword: quest.keyword,
          normalized,
          chars: Array.from(normalized),
          wordCount: normalized.split(' ').length,
          strict: quest.strict === true,
        };
      })
      .sort((a, b) => b.chars.length - a.chars.length);
    this.fuzzyQuests = this.quests.filter((quest) => !quest.strict);
  }

  match(caption: string): QuestMatch {
    const text = normalizeText(caption);
    if (text === '') return { kind: 'none' };
    // Captions are short; bounding the typo search keeps a 4000-character message cheap.
    const words = text.split(' ').slice(0, MAX_FUZZY_WORDS);

    const exact = this.quests.find((quest) =>
      quest.strict ? hasWholeWords(text, quest.normalized) : text.includes(quest.normalized),
    );
    if (exact) {
      const moreSpecific = this.fuzzyQuests.filter(
        (quest) => quest.chars.length > exact.chars.length && quest.normalized.includes(exact.normalized),
      );
      const typo = this.bestFuzzy(words, moreSpecific, exact.normalized);
      if (typo) return typo;
      return { kind: 'exact', type: exact.type, keyword: exact.keyword };
    }

    return this.bestFuzzy(words, this.fuzzyQuests) ?? { kind: 'none' };
  }

  /** With `extending`, only windows holding that exact text plus something more are considered. */
  private bestFuzzy(words: string[], candidates: CompiledQuest[], extending?: string): QuestMatch | undefined {
    let best: { quest: CompiledQuest; score: number; window: string } | undefined;
    const maxGap = 1 - this.threshold + EPSILON;

    // Candidates are longest-first, so on a tie the earlier (longer) keyword is kept.
    for (const quest of candidates) {
      const minSize = Math.max(1, quest.wordCount - 1);
      const maxSize = Math.min(words.length, quest.wordCount + 1);
      for (let size = minSize; size <= maxSize; size++) {
        for (let start = 0; start + size <= words.length; start++) {
          const window = words.slice(start, start + size).join(' ');
          if (extending !== undefined && (window === extending || !window.includes(extending))) continue;
          const chars = Array.from(window);
          const longest = Math.max(chars.length, quest.chars.length);
          // The length difference alone bounds the edit distance from below.
          if (Math.abs(chars.length - quest.chars.length) / longest > maxGap) continue;
          const score = 1 - levenshtein(chars, quest.chars) / longest;
          if (!best || score > best.score + EPSILON) best = { quest, score, window };
        }
      }
    }

    if (!best || best.score + EPSILON < this.threshold) return undefined;
    return { kind: 'fuzzy', type: best.quest.type, keyword: best.quest.keyword, score: best.score, window: best.window };
  }
}

/** Edit distance (insert, delete, substitute) between two sequences of code points. */
export function levenshtein(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

/** Levenshtein ratio: 1 for identical strings, 0 for nothing in common. */
export function similarity(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const longest = Math.max(x.length, y.length);
  return longest === 0 ? 1 : 1 - levenshtein(x, y) / longest;
}

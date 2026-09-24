import { describe, expect, it } from 'vitest';
import type { Quest } from '../src/config.js';
import { QuestMatcher, levenshtein, normalizeText, similarity } from '../src/matcher.js';

// Deliberately awkward set: siblings sharing a word ("share post" / "boost post"),
// and a short keyword contained in longer ones ("check-in").
const QUESTS: Quest[] = [
  { keyword: 'check-in', type: 'check_in' },
  { keyword: 'share post', type: 'share_post' },
  { keyword: 'daily check-in', type: 'daily_check_in' },
  { keyword: 'boost post', type: 'boost_post' },
  { keyword: 'event check-in', type: 'event_check_in' },
  { keyword: 'event attendance', type: 'event_attendance' },
  { keyword: 'invite', type: 'invite' },
];

const matcher = new QuestMatcher(QUESTS, 0.8);

describe('normalizeText', () => {
  it('lower-cases and collapses punctuation, emoji and whitespace', () => {
    expect(normalizeText('  **Share-Post** ✅\n\tdone!! ')).toBe('share post done');
    expect(normalizeText('ＳＨＡＲＥ　ＰＯＳＴ')).toBe('share post'); // full-width forms (NFKC)
  });
});

describe('levenshtein / similarity', () => {
  it('computes edit distance on code points', () => {
    expect(levenshtein([...'kitten'], [...'sitting'])).toBe(3);
    expect(levenshtein([], [...'abc'])).toBe(3);
    expect(similarity('invite', 'invte')).toBeCloseTo(5 / 6);
    expect(similarity('', '')).toBe(1);
  });
});

describe('QuestMatcher: specificity', () => {
  it('prefers the longest keyword that appears in the caption', () => {
    expect(matcher.match('Daily Check-In ✅')).toEqual({ kind: 'exact', type: 'daily_check_in', keyword: 'daily check-in' });
    expect(matcher.match('event check-in done')).toMatchObject({ kind: 'exact', type: 'event_check_in' });
    expect(matcher.match('check-in')).toMatchObject({ kind: 'exact', type: 'check_in' });
  });

  it('never confuses sibling keywords that share a word', () => {
    expect(matcher.match('boost post')).toMatchObject({ kind: 'exact', type: 'boost_post' });
    expect(matcher.match('share post')).toMatchObject({ kind: 'exact', type: 'share_post' });
    expect(matcher.match('BOOST POST ✅')).toMatchObject({ kind: 'exact', type: 'boost_post' });
  });

  it('does not depend on the order quests are configured in', () => {
    const reversed = new QuestMatcher([...QUESTS].reverse(), 0.8);
    for (const caption of ['daily check-in', 'check-in', 'boost post', 'share post', 'evnt attendance']) {
      expect(reversed.match(caption)).toEqual(matcher.match(caption));
    }
  });

  it('lets a close typo of a longer keyword beat the shorter keyword it contains', () => {
    expect(matcher.match('daly check-in')).toMatchObject({ kind: 'fuzzy', type: 'daily_check_in' });
    expect(matcher.match('evnt check-in')).toMatchObject({ kind: 'fuzzy', type: 'event_check_in' });
    // Not a typo of either longer keyword, so the exact short keyword stands.
    expect(matcher.match('weekly check-in')).toMatchObject({ kind: 'exact', type: 'check_in' });
  });
});

describe('QuestMatcher: case and spacing', () => {
  it.each([
    'share post',
    'SHARE POST',
    'Share Post',
    '   share      post   ',
    'share\npost',
    'share-post',
    'share_post',
    '**share post**',
    'done - SHARE POST ✅',
    'Share Post✅',
  ])('%j is an exact share_post', (caption) => {
    expect(matcher.match(caption)).toEqual({ kind: 'exact', type: 'share_post', keyword: 'share post' });
  });

  it('matches a keyword anywhere in the caption, including inside longer words', () => {
    expect(matcher.match('I invited 3 friends today')).toMatchObject({ kind: 'exact', type: 'invite' });
  });
});

describe('QuestMatcher: typo tolerance', () => {
  it.each([
    ['event attendence', 'event_attendance'],
    ['done - event attendence ✅', 'event_attendance'],
    ['evnt attendance', 'event_attendance'],
    ['event atendance!!', 'event_attendance'],
    ['eventattendance', 'event_attendance'], // merged words
    ['event atten dance', 'event_attendance'], // split word
    ['shre post', 'share_post'],
    ['my boost pots', 'boost_post'],
    ['invte', 'invite'],
  ])('%j is a fuzzy %s', (caption, type) => {
    const result = matcher.match(caption);
    expect(result).toMatchObject({ kind: 'fuzzy', type });
    if (result.kind === 'fuzzy') {
      expect(result.score).toBeGreaterThanOrEqual(0.8);
      expect(result.score).toBeLessThan(1);
    }
  });

  it('picks the highest-scoring keyword when several clear the threshold', () => {
    // "event pist" is one edit from "event post" (0.9) and two from "event pass" (0.8).
    const quests: Quest[] = [
      { keyword: 'event pass', type: 'event_pass' },
      { keyword: 'event post', type: 'event_post' },
    ];
    for (const ordered of [quests, [...quests].reverse()]) {
      const result = new QuestMatcher(ordered, 0.8).match('event pist');
      expect(result).toMatchObject({ kind: 'fuzzy', type: 'event_post' });
      expect(result.kind === 'fuzzy' && result.score).toBeCloseTo(0.9);
    }
    expect(similarity('event pist', 'event pass')).toBeCloseTo(0.8);
  });

  it('breaks score ties in favour of the longer keyword, whatever the config order', () => {
    // "photos" is one edit from both keywords; both score 1 - 1/6.
    const quests: Quest[] = [
      { keyword: 'phtos', type: 'shorter' },
      { keyword: 'photas', type: 'longer' },
    ];
    expect(new QuestMatcher(quests, 0.8).match('photos')).toMatchObject({ kind: 'fuzzy', type: 'longer' });
    expect(new QuestMatcher([...quests].reverse(), 0.8).match('photos')).toMatchObject({ kind: 'fuzzy', type: 'longer' });
  });

  it('respects the threshold', () => {
    // "event attendence" scores 15/16 = 0.9375.
    expect(new QuestMatcher(QUESTS, 0.9).match('event attendence')).toMatchObject({ kind: 'fuzzy' });
    expect(new QuestMatcher(QUESTS, 0.95).match('event attendence')).toEqual({ kind: 'none' });
    expect(new QuestMatcher(QUESTS, 1).match('event attendence')).toEqual({ kind: 'none' });
  });
});

describe('QuestMatcher: unmatched', () => {
  it.each(['', '   ', '✅✅', 'gm everyone', 'here is my screenshot', 'posting', 'attendance'])(
    '%j matches nothing',
    (caption) => {
      expect(matcher.match(caption)).toEqual({ kind: 'none' });
    },
  );

  it('stays fast on a maximum-length message', () => {
    const caption = 'lorem ipsum dolor sit amet '.repeat(150); // ~4000 chars, no keyword
    const started = performance.now();
    expect(matcher.match(caption)).toEqual({ kind: 'none' });
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('QuestMatcher: construction', () => {
  it('rejects keywords that collide after normalisation', () => {
    expect(() => new QuestMatcher([{ keyword: 'Share Post', type: 'a' }, { keyword: 'share-post', type: 'b' }], 0.8)).toThrow(
      /duplicates quests\[0\]/,
    );
  });
});

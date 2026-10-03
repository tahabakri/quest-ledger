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

  it('never lets the guard turn an exact hit into a longer keyword it merely resembles', () => {
    // "day 1" is one edit from "day 10": that is not evidence for day 10.
    const days = new QuestMatcher(
      Array.from({ length: 14 }, (_, i) => ({ keyword: `Day ${i + 1}`, type: `day_${i + 1}` })),
      0.8,
    );
    expect(days.match('Day 1 done ✅')).toMatchObject({ kind: 'exact', type: 'day_1' });
    expect(days.match('day 1')).toMatchObject({ kind: 'exact', type: 'day_1' });
    expect(days.match('Day 12 ✅')).toMatchObject({ kind: 'exact', type: 'day_12' });
    // Another keyword in the caption ("day 2", one edit from "day 12") is not evidence either.
    expect(days.match('day 1 and day 2')).toMatchObject({ kind: 'exact', type: 'day_1' });

    const plural = new QuestMatcher(
      [
        { keyword: 'check-in', type: 'check_in' },
        { keyword: 'check-ins', type: 'check_ins' },
      ],
      0.8,
    );
    expect(plural.match('check-in ✅')).toMatchObject({ kind: 'exact', type: 'check_in' });
    expect(plural.match('3 check-ins')).toMatchObject({ kind: 'exact', type: 'check_ins' });
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

describe('QuestMatcher: strict keywords', () => {
  const QUESTS_WITH_STRICT: Quest[] = [
    { keyword: 'join', type: 'event_join', strict: true },
    { keyword: 'join event', type: 'event_join' },
    { keyword: 'tour', type: 'weekly_tour', strict: true },
    { keyword: 'weekly tour', type: 'weekly_tour' },
    { keyword: 'share post', type: 'share_post' },
  ];
  const strictMatcher = new QuestMatcher(QUESTS_WITH_STRICT, 0.8);

  it.each([
    ['join', 'event_join'],
    ['JOIN ✅', 'event_join'],
    ['Join!', 'event_join'],
    ['done - join', 'event_join'],
    ['how to join us', 'event_join'],
    ['tour', 'weekly_tour'],
    ['Tour: loved the second stop', 'weekly_tour'],
    ['Join Event', 'event_join'],
    ['Weekly Tour', 'weekly_tour'],
  ])('%j is an exact %s', (caption, type) => {
    expect(strictMatcher.match(caption)).toMatchObject({ kind: 'exact', type });
  });

  it.each(['joint', 'joined', 'joining', 'disjoin', 'tourist', 'detour', 'contour', 'tours'])(
    '%j does not match a strict keyword hidden inside another word',
    (caption) => {
      expect(strictMatcher.match(caption)).toEqual({ kind: 'none' });
    },
  );

  it('gives strict keywords no typo tolerance', () => {
    expect(strictMatcher.match('jon')).toEqual({ kind: 'none' });
    expect(strictMatcher.match('tor')).toEqual({ kind: 'none' });
    // Without strict, the keyword is found inside longer words.
    const loose = new QuestMatcher([{ keyword: 'join', type: 'event_join' }], 0.8);
    expect(loose.match('joint')).toMatchObject({ kind: 'exact', type: 'event_join' });
  });

  it('still tolerates typos in the longer, non-strict aliases', () => {
    expect(strictMatcher.match('weekly tou')).toMatchObject({ kind: 'fuzzy', type: 'weekly_tour' });
    expect(strictMatcher.match('joim event')).toMatchObject({ kind: 'fuzzy', type: 'event_join' });
  });

  it('lets a longer keyword elsewhere in the caption win over a strict one', () => {
    expect(strictMatcher.match('tour for the share post')).toMatchObject({ kind: 'exact', type: 'share_post' });
  });

  it('does not depend on the order quests are configured in', () => {
    const reversed = new QuestMatcher([...QUESTS_WITH_STRICT].reverse(), 0.8);
    for (const caption of ['join', 'tour', 'joint', 'detour', 'Weekly Tour', 'weekly tou', 'tour for the share post']) {
      expect(reversed.match(caption)).toEqual(strictMatcher.match(caption));
    }
  });
});

describe('QuestMatcher: review keywords', () => {
  const QUESTS_WITH_REVIEW: Quest[] = [
    { keyword: 'share post', type: 'share_post' },
    { keyword: 'sharing post', type: 'share_post', review: true },
    { keyword: 'boost post', type: 'boost_post' },
    { keyword: 'boosting post', type: 'boost_post', review: true },
  ];
  const reviewMatcher = new QuestMatcher(QUESTS_WITH_REVIEW, 0.8);

  it('catches what typo matching cannot: an "-ing" form is only 0.75 similar', () => {
    const withoutVariant = new QuestMatcher([{ keyword: 'share post', type: 'share_post' }], 0.8);
    expect(withoutVariant.match('sharing post')).toEqual({ kind: 'none' });
  });

  it('logs the close variant under its quest and marks it for review', () => {
    expect(reviewMatcher.match('Sharing Post ✅')).toEqual({
      kind: 'exact',
      type: 'share_post',
      keyword: 'sharing post',
      review: true,
    });
    expect(reviewMatcher.match('boosting post')).toEqual({
      kind: 'exact',
      type: 'boost_post',
      keyword: 'boosting post',
      review: true,
    });
  });

  it('leaves the official caption unmarked', () => {
    expect(reviewMatcher.match('share post')).toEqual({ kind: 'exact', type: 'share_post', keyword: 'share post' });
  });

  it('does not mark it when the official caption is in the text as well', () => {
    expect(reviewMatcher.match('sharing post (share post)')).toEqual({
      kind: 'exact',
      type: 'share_post',
      keyword: 'share post',
    });
  });

  it('still catches typos of the variant, as fuzzy matches', () => {
    expect(reviewMatcher.match('sharng post')).toMatchObject({ kind: 'fuzzy', type: 'share_post' });
  });

  it('does not depend on the order quests are configured in', () => {
    const reversed = new QuestMatcher([...QUESTS_WITH_REVIEW].reverse(), 0.8);
    for (const caption of ['sharing post', 'share post', 'sharing post (share post)', 'boosting post', 'sharng post']) {
      expect(reversed.match(caption)).toEqual(reviewMatcher.match(caption));
    }
  });
});

describe('QuestMatcher: construction', () => {
  it('rejects keywords that collide after normalisation', () => {
    expect(() => new QuestMatcher([{ keyword: 'Share Post', type: 'a' }, { keyword: 'share-post', type: 'b' }], 0.8)).toThrow(
      /duplicates quests\[0\]/,
    );
  });
});

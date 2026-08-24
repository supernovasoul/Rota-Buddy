import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCoveringCombinations, coveringCombinationsByHeadcount, combinationPaidHours } from './coverage.js';

// the exact reception shift types from app/data-model.md's shiftTypeSets example
const MORNING = { id: 'm', name: 'Morning', start: '10:30', end: '15:30', breakMinutes: 0 };
const LATE = { id: 'l', name: 'Late', start: '15:15', end: '21:00', breakMinutes: 30 };
const WHOLE_DAY = { id: 'w', name: 'Whole day', start: '10:30', end: '21:00', breakMinutes: 60 };
const WEEKEND_FULL_DAY = { id: 'we', name: 'Weekend full day', start: '08:30', end: '18:00', breakMinutes: 60 };
const RECEPTION_TYPES = [MORNING, LATE, WHOLE_DAY, WEEKEND_FULL_DAY];

test('finds both the whole-day type alone and the overlapping Morning+Late split as valid weekday coverage', () => {
  const combos = findCoveringCombinations(RECEPTION_TYPES, '10:30', '21:00');
  const names = combos.map((c) => c.map((t) => t.name).sort().join('+')).sort();
  assert.ok(names.includes('Whole day'), 'whole-day alone should be a valid combination');
  assert.ok(names.includes('Late+Morning'), 'the overlapping Morning+Late split should be a valid combination');
});

test('an overlap between adjacent shift types does not disqualify a combination', () => {
  // Morning ends 15:30, Late starts 15:15 - a 15 minute overlap, deliberately
  const combos = findCoveringCombinations([MORNING, LATE], '10:30', '21:00');
  assert.equal(combos.length, 1);
  assert.deepEqual(combos[0].map((t) => t.name).sort(), ['Late', 'Morning']);
});

test('a genuine gap between shift types is rejected', () => {
  const morningOnly = { id: 'm2', name: 'Morning', start: '10:30', end: '14:00' };
  const lateOnly = { id: 'l2', name: 'Late', start: '16:00', end: '21:00' }; // 2h gap, 14:00-16:00
  const combos = findCoveringCombinations([morningOnly, lateOnly], '10:30', '21:00');
  assert.equal(combos.length, 0);
});

test('a single type that does not span the full opening hours is rejected alone', () => {
  const combos = findCoveringCombinations([MORNING], '10:30', '21:00');
  assert.equal(combos.length, 0);
});

test('weekend opening hours are covered by the weekend full-day type', () => {
  const combos = findCoveringCombinations(RECEPTION_TYPES, '08:30', '18:00');
  assert.ok(combos.some((c) => c.length === 1 && c[0].name === 'Weekend full day'));
});

test('coveringCombinationsByHeadcount orders single-person combinations before multi-person ones', () => {
  const combos = coveringCombinationsByHeadcount(RECEPTION_TYPES, '10:30', '21:00');
  assert.equal(combos[0].length, 1); // whole-day (1 person) sorts before Morning+Late (2 people)
});

test('combinationPaidHours sums each shift type\'s own paid hours - overlap is not netted between the two people', () => {
  const paidHours = combinationPaidHours([MORNING, LATE]);
  // Morning: 5h span, 0 break = 5h paid. Late: 5.75h span, 0.5h break = 5.25h paid.
  // Total counts BOTH people's full paid time through the 15-minute overlap, not a deduplicated span.
  assert.equal(paidHours, 5 + 5.25);
});

test('combinationPaidHours for the whole-day alternative reflects its own single break', () => {
  assert.equal(combinationPaidHours([WHOLE_DAY]), 9.5); // 10.5h span - 1h break
});

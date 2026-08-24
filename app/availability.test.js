import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  datesInMonth, previousMonth, patternDaysOfWeek, setWeeklyPattern, effectiveAvailability,
  hasExplicitOverride, setDayOverride, copyOverridesToMonth,
} from './availability.js';

test('datesInMonth: returns every date in a 31-day month', () => {
  const dates = datesInMonth(2026, 8);
  assert.equal(dates.length, 31);
  assert.equal(dates[0], '2026-08-01');
  assert.equal(dates[30], '2026-08-31');
});

test('datesInMonth: correctly handles a shorter month (February, non-leap year)', () => {
  const dates = datesInMonth(2026, 2);
  assert.equal(dates.length, 28);
  assert.equal(dates[27], '2026-02-28');
});

test('previousMonth: steps back a month within the same year', () => {
  assert.deepEqual(previousMonth(2026, 8), { year: 2026, month: 7 });
});

test('previousMonth: steps back across a year boundary from January', () => {
  assert.deepEqual(previousMonth(2026, 1), { year: 2025, month: 12 });
});

test('patternDaysOfWeek: someone never configured has hasPattern=false and an empty day set', () => {
  const result = patternDaysOfWeek([], 1);
  assert.equal(result.hasPattern, false);
  assert.deepEqual([...result.days], []);
});

test('patternDaysOfWeek: only reads rows for the requested staff member', () => {
  const patterns = [{ staffId: 1, dayOfWeek: 5, available: true }, { staffId: 2, dayOfWeek: 0, available: true }];
  const result = patternDaysOfWeek(patterns, 1);
  assert.equal(result.hasPattern, true);
  assert.deepEqual([...result.days], [5]);
});

test('setWeeklyPattern: writes all 7 days, replacing any previous pattern for that person entirely', () => {
  const existing = [{ staffId: 1, dayOfWeek: 0, available: true }];
  const updated = setWeeklyPattern(existing, 1, new Set([5, 6]));
  assert.equal(updated.length, 7);
  const byDow = Object.fromEntries(updated.map((p) => [p.dayOfWeek, p.available]));
  assert.equal(byDow[0], false); // Monday - no longer available, since the new set replaced the old one entirely
  assert.equal(byDow[5], true);
  assert.equal(byDow[6], true);
});

test('setWeeklyPattern: leaves other staff members\' patterns untouched', () => {
  const existing = [{ staffId: 2, dayOfWeek: 0, available: true }];
  const updated = setWeeklyPattern(existing, 1, new Set([0]));
  assert.ok(updated.some((p) => p.staffId === 2 && p.dayOfWeek === 0 && p.available === true));
});

test('effectiveAvailability: with no pattern and no override, every day is available (unconstrained default)', () => {
  assert.equal(effectiveAvailability(1, '2026-08-05', [], []), true);
});

test('effectiveAvailability: a configured pattern restricts to only its available days', () => {
  const patterns = [{ staffId: 1, dayOfWeek: 5, available: true }, { staffId: 1, dayOfWeek: 6, available: true }];
  assert.equal(effectiveAvailability(1, '2026-08-05', [], patterns), false); // Wednesday
  assert.equal(effectiveAvailability(1, '2026-08-08', [], patterns), true); // Saturday
});

test('effectiveAvailability: an explicit override always wins over the pattern, either direction', () => {
  const patterns = [{ staffId: 1, dayOfWeek: 5, available: true }, { staffId: 1, dayOfWeek: 6, available: true }];
  const availability = [
    { id: 'a1', staffId: 1, dateFrom: '2026-08-05', dateTo: '2026-08-05', type: 'available', note: '' }, // Wednesday, picked up extra
    { id: 'a2', staffId: 1, dateFrom: '2026-08-08', dateTo: '2026-08-08', type: 'holiday', note: '' }, // Saturday, on leave
  ];
  assert.equal(effectiveAvailability(1, '2026-08-05', availability, patterns), true);
  assert.equal(effectiveAvailability(1, '2026-08-08', availability, patterns), false);
});

test('hasExplicitOverride: true only for a date genuinely covered by a one-off entry', () => {
  const availability = [{ id: 'a1', staffId: 1, dateFrom: '2026-08-05', dateTo: '2026-08-05', type: 'unavailable', note: '' }];
  assert.equal(hasExplicitOverride(1, '2026-08-05', availability), true);
  assert.equal(hasExplicitOverride(1, '2026-08-06', availability), false);
  assert.equal(hasExplicitOverride(2, '2026-08-05', availability), false);
});

test('setDayOverride: adding a new override for a date with none yet', () => {
  const result = setDayOverride([], 1, '2026-08-05', 'unavailable', () => 'new-id');
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'unavailable');
  assert.equal(result[0].id, 'new-id');
});

test('setDayOverride: overwriting an existing override for the same date replaces it, not duplicates', () => {
  const existing = [{ id: 'old', staffId: 1, dateFrom: '2026-08-05', dateTo: '2026-08-05', type: 'unavailable', note: '' }];
  const result = setDayOverride(existing, 1, '2026-08-05', 'available', () => 'new-id');
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'available');
});

test('setDayOverride: passing null clears the override, falling back to the pattern default', () => {
  const existing = [{ id: 'old', staffId: 1, dateFrom: '2026-08-05', dateTo: '2026-08-05', type: 'unavailable', note: '' }];
  const result = setDayOverride(existing, 1, '2026-08-05', null, () => 'unused');
  assert.deepEqual(result, []);
});

test('setDayOverride: never touches a different staff member\'s override on the same date', () => {
  const existing = [{ id: 'a', staffId: 1, dateFrom: '2026-08-05', dateTo: '2026-08-05', type: 'unavailable', note: '' }];
  const result = setDayOverride(existing, 2, '2026-08-05', 'available', () => 'new-id');
  assert.equal(result.length, 2);
});

test('copyOverridesToMonth: throws if the two months are different lengths', () => {
  assert.throws(() => copyOverridesToMonth([], [1], datesInMonth(2026, 8), datesInMonth(2026, 2), () => 'x'));
});

test('copyOverridesToMonth: copies each day\'s override to the same relative day of the target month', () => {
  const august = datesInMonth(2026, 8);
  const september = datesInMonth(2026, 9); // both 31/30 days respectively - use two same-length months instead
  const july = datesInMonth(2026, 7); // 31 days, same as August
  const availability = [{ id: 'old', staffId: 1, dateFrom: july[4], dateTo: july[4], type: 'holiday', note: '' }]; // 5th of July
  const result = copyOverridesToMonth(availability, [1], july, august, () => 'new-id');
  const copied = result.find((a) => a.dateFrom === august[4]); // 5th of August
  assert.ok(copied, 'the override should have been copied to the same day-of-month in August');
  assert.equal(copied.type, 'holiday');
});

test('copyOverridesToMonth: a target date with no source override is cleared, not left stale', () => {
  const july = datesInMonth(2026, 7);
  const august = datesInMonth(2026, 8);
  // August 5th already has a leftover override that July 5th does NOT have
  const availability = [{ id: 'stale', staffId: 1, dateFrom: august[4], dateTo: august[4], type: 'unavailable', note: '' }];
  const result = copyOverridesToMonth(availability, [1], july, august, () => 'new-id');
  assert.ok(!result.some((a) => a.dateFrom === august[4]), 'the stale August override should be cleared since July had nothing there');
});

test('copyOverridesToMonth: only copies for the given staff members, leaving others alone', () => {
  const july = datesInMonth(2026, 7);
  const august = datesInMonth(2026, 8);
  const availability = [
    { id: 'a', staffId: 1, dateFrom: july[4], dateTo: july[4], type: 'holiday', note: '' },
    { id: 'b', staffId: 2, dateFrom: august[4], dateTo: august[4], type: 'available', note: 'unrelated existing entry' },
  ];
  const result = copyOverridesToMonth(availability, [1], july, august, () => 'new-id');
  assert.ok(result.some((a) => a.staffId === 2 && a.dateFrom === august[4] && a.type === 'available'), 'staff 2\'s untouched entry should survive');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollingAverageHours, computeWtrWarning, computeWtrWarnings } from './wtrWarning.js';

test('rollingAverageHours: with no prior history, the average is just this week alone', () => {
  assert.equal(rollingAverageHours([], 50), 50);
});

test('rollingAverageHours: averages across this week plus all available history when under 17 weeks total', () => {
  // 3 prior weeks of 40h + this week's 60h = 4 weeks total
  assert.equal(rollingAverageHours([40, 40, 40], 60), (40 * 3 + 60) / 4);
});

test('rollingAverageHours: caps the window at 17 weeks total, dropping the oldest history beyond that', () => {
  const sixteenOldWeeksAt60 = new Array(16).fill(60); // 16 prior weeks, all high
  const oneExtraOldWeekAt0 = [0, ...sixteenOldWeeksAt60]; // 17 prior weeks total - the oldest (0h) should be dropped
  const average = rollingAverageHours(oneExtraOldWeekAt0, 60);
  // if the 0h week were included, the average would be lower - confirm it's excluded
  assert.equal(average, 60, 'only the most recent 16 prior weeks plus this week (all 60h) should count');
});

test('computeWtrWarning: no warning when the average sits at or under the 48h threshold', () => {
  assert.equal(computeWtrWarning({ id: 1 }, [48, 48, 48], 48), null);
});

test('computeWtrWarning: a warning fires once the average genuinely exceeds 48h, with the real average and week count attached', () => {
  const warning = computeWtrWarning({ id: 1 }, [50, 50], 50);
  assert.ok(warning);
  assert.equal(warning.staffId, 1);
  assert.equal(warning.averageHoursPerWeek, 50);
  assert.equal(warning.weekCount, 3);
});

test('computeWtrWarning: someone with a single very high week and no prior history still gets warned - it is a real average, not delayed until 17 weeks accumulate', () => {
  const warning = computeWtrWarning({ id: 1 }, [], 60);
  assert.ok(warning);
  assert.equal(warning.weekCount, 1);
});

test('computeWtrWarnings: only returns the people actually over the threshold', () => {
  const staff = [{ id: 1 }, { id: 2 }];
  const recentWeeklyHoursByStaffId = { 1: [55, 55], 2: [30, 30] };
  const thisWeekHoursByStaffId = { 1: 55, 2: 30 };
  const warnings = computeWtrWarnings(staff, recentWeeklyHoursByStaffId, thisWeekHoursByStaffId);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].staffId, 1);
});

test('computeWtrWarnings: a staff member missing from the history maps defaults to no prior weeks, not an error', () => {
  const staff = [{ id: 1 }];
  const warnings = computeWtrWarnings(staff, {}, { 1: 30 });
  assert.deepEqual(warnings, []);
});

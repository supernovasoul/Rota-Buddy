import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRestWeekPolicy, weeksSinceLastBreak, computeRestWeekNudge, computeRestWeekNudges } from './restWeekNudge.js';

const DEFAULTS = {
  flex: { enabled: true, minWeeks: 9, maxWeeks: 13 },
  fixed_pattern: { enabled: false, minWeeks: null, maxWeeks: null },
};

function weeksOf(pattern, staffId) {
  // pattern: array of booleans, oldest -> newest; true = worked that week
  return pattern.map((worked, i) => ({
    weekStart: `2026-W${i}`,
    staffIdsWithShifts: worked ? [staffId] : [],
  }));
}

test('policy resolution: flex staff inherit the flex default', () => {
  const staff = { id: 1, employmentType: 'flex', restWeekPolicyOverride: null };
  assert.deepEqual(resolveRestWeekPolicy(staff, DEFAULTS), DEFAULTS.flex);
});

test('policy resolution: fixed_pattern staff inherit the disabled default', () => {
  const staff = { id: 2, employmentType: 'fixed_pattern', restWeekPolicyOverride: null };
  assert.equal(resolveRestWeekPolicy(staff, DEFAULTS).enabled, false);
});

test('policy resolution: per-person override wins over the default', () => {
  const staff = { id: 3, employmentType: 'flex', restWeekPolicyOverride: { enabled: false, minWeeks: null, maxWeeks: null } };
  assert.equal(resolveRestWeekPolicy(staff, DEFAULTS).enabled, false);
});

test('policy resolution: per-person override can set a custom window', () => {
  const staff = { id: 4, employmentType: 'flex', restWeekPolicyOverride: { enabled: true, minWeeks: 20, maxWeeks: 26 } };
  const policy = resolveRestWeekPolicy(staff, DEFAULTS);
  assert.equal(policy.minWeeks, 20);
  assert.equal(policy.maxWeeks, 26);
});

test('weeksSinceLastBreak: counts backward from the most recent week', () => {
  const recentWeeks = weeksOf([true, true, false, true, true, true], 1);
  assert.equal(weeksSinceLastBreak(1, recentWeeks), 3); // last 3 weeks worked, week before that was a gap
});

test('weeksSinceLastBreak: no gap ever in the window = full streak', () => {
  const recentWeeks = weeksOf(Array(13).fill(true), 1);
  assert.equal(weeksSinceLastBreak(1, recentWeeks), 13);
});

test('weeksSinceLastBreak: a gap last week resets the streak to 0', () => {
  const recentWeeks = weeksOf([true, true, true, true, false], 1);
  assert.equal(weeksSinceLastBreak(1, recentWeeks), 0);
});

test('nudge: below minWeeks streak produces no nudge', () => {
  const staff = { id: 1, employmentType: 'flex', restWeekPolicyOverride: null };
  const recentWeeks = weeksOf(Array(8).fill(true), 1);
  assert.equal(computeRestWeekNudge(staff, DEFAULTS, recentWeeks), null);
});

test('nudge: exactly minWeeks streak is "approaching"', () => {
  const staff = { id: 1, employmentType: 'flex', restWeekPolicyOverride: null };
  const recentWeeks = weeksOf(Array(9).fill(true), 1);
  const nudge = computeRestWeekNudge(staff, DEFAULTS, recentWeeks);
  assert.equal(nudge.severity, 'approaching');
  assert.equal(nudge.weeksSinceBreak, 9);
});

test('nudge: at or past maxWeeks streak is "overdue"', () => {
  const staff = { id: 1, employmentType: 'flex', restWeekPolicyOverride: null };
  const recentWeeks = weeksOf(Array(14).fill(true), 1);
  const nudge = computeRestWeekNudge(staff, DEFAULTS, recentWeeks);
  assert.equal(nudge.severity, 'overdue');
  assert.equal(nudge.weeksSinceBreak, 14);
});

test('nudge: a natural break well inside the window means no nudge, not an extra one stacked on top', () => {
  const staff = { id: 1, employmentType: 'flex', restWeekPolicyOverride: null };
  // worked 20 weeks, took a natural gap, then worked 5 more since - streak
  // since the gap is only 5, well under minWeeks, even though 20+ weeks
  // have passed overall
  const recentWeeks = weeksOf([...Array(20).fill(true), false, ...Array(5).fill(true)], 1);
  assert.equal(computeRestWeekNudge(staff, DEFAULTS, recentWeeks), null);
});

test('nudge: disabled policy never nudges regardless of streak length', () => {
  const staff = { id: 2, employmentType: 'fixed_pattern', restWeekPolicyOverride: null };
  const recentWeeks = weeksOf(Array(30).fill(true), 2);
  assert.equal(computeRestWeekNudge(staff, DEFAULTS, recentWeeks), null);
});

test('nudge: explicit per-person disable overrides an otherwise-active flex default', () => {
  const staff = { id: 3, employmentType: 'flex', restWeekPolicyOverride: { enabled: false, minWeeks: null, maxWeeks: null } };
  const recentWeeks = weeksOf(Array(30).fill(true), 3);
  assert.equal(computeRestWeekNudge(staff, DEFAULTS, recentWeeks), null);
});

test('nudge: custom per-person window is honoured over the default 9/13', () => {
  const staff = { id: 4, employmentType: 'flex', restWeekPolicyOverride: { enabled: true, minWeeks: 20, maxWeeks: 26 } };
  const recentWeeks = weeksOf(Array(13).fill(true), 4);
  // would be "overdue" under the default window, but this person's own
  // override says 20/26, so 13 straight weeks shouldn't nudge yet
  assert.equal(computeRestWeekNudge(staff, DEFAULTS, recentWeeks), null);
});

test('computeRestWeekNudges: only returns entries for staff who actually have a nudge', () => {
  const staffList = [
    { id: 1, employmentType: 'flex', restWeekPolicyOverride: null }, // 14 weeks - overdue
    { id: 2, employmentType: 'fixed_pattern', restWeekPolicyOverride: null }, // disabled
    { id: 3, employmentType: 'flex', restWeekPolicyOverride: null }, // 3 weeks - no nudge
  ];
  const recentWeeks = [
    ...weeksOf(Array(14).fill(true), 1),
  ].map((w, i) => ({
    weekStart: w.weekStart,
    staffIdsWithShifts: [
      ...(i >= 0 ? [1] : []),
      2,
      ...(i >= 11 ? [3] : []), // staff 3 only worked the last 3 weeks
    ],
  }));

  const nudges = computeRestWeekNudges(staffList, DEFAULTS, recentWeeks);
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].staffId, 1);
  assert.equal(nudges[0].severity, 'overdue');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weeklyCapHours, weeklyPaidHours, weeklyCapViolations } from './weeklyCap.js';

const CAP_SETTING = { defaultCapHours: 39 };

const WHOLE_DAY = { id: 'w', name: 'Whole day', start: '10:30', end: '21:00', breakMinutes: 60 }; // 9.5h paid
const MORNING = { id: 'm', name: 'Morning', start: '10:30', end: '15:30', breakMinutes: 0 }; // 5h paid
const WEEKDAY_THERAPIST = { id: 't', name: 'Weekday', start: '11:00', end: '20:00', breakMinutes: 60 }; // 8h paid

test('weeklyCapHours: no override falls back to the configured default', () => {
  const staff = { id: 1, weeklyHourCapOverride: null };
  assert.equal(weeklyCapHours(staff, CAP_SETTING), 39);
});

test('weeklyCapHours: an approved override sets a specific higher ceiling, not unlimited', () => {
  const staff = { id: 2, weeklyHourCapOverride: { approved: true, approvedAt: '2026-01-01', note: 'approved for extra hours', capHours: 45 } };
  assert.equal(weeklyCapHours(staff, CAP_SETTING), 45);
});

test('weeklyCapHours: an unapproved override object does not raise the cap', () => {
  const staff = { id: 3, weeklyHourCapOverride: { approved: false, approvedAt: null, note: 'requested, not yet approved', capHours: 45 } };
  assert.equal(weeklyCapHours(staff, CAP_SETTING), 39);
});

test('weeklyCapHours: default cap number comes entirely from settings, not a hardcoded constant', () => {
  const staff = { id: 1, weeklyHourCapOverride: null };
  assert.equal(weeklyCapHours(staff, { defaultCapHours: 35 }), 35);
});

test('weeklyPaidHours: sums paid hours (not wall-clock span) across mixed shift types', () => {
  // one whole-day reception shift (9.5h paid) + nothing else
  assert.equal(weeklyPaidHours([WHOLE_DAY]), 9.5);
  // a lighter week: one morning shift only
  assert.equal(weeklyPaidHours([MORNING]), 5);
  // a therapist working the same weekday type on 4 different days
  assert.equal(weeklyPaidHours([WEEKDAY_THERAPIST, WEEKDAY_THERAPIST, WEEKDAY_THERAPIST, WEEKDAY_THERAPIST]), 32);
});

test('weeklyCapViolations: under the cap produces no violation', () => {
  const staff = [{ id: 1, weeklyHourCapOverride: null }];
  const assigned = { 1: [WHOLE_DAY, WHOLE_DAY, WHOLE_DAY] }; // 28.5h, under 39
  assert.deepEqual(weeklyCapViolations(staff, CAP_SETTING, assigned), []);
});

test('weeklyCapViolations: exactly at the cap is compliant, not a violation', () => {
  const staff = [{ id: 1, weeklyHourCapOverride: null }];
  const assigned = { 1: Array(6).fill(WEEKDAY_THERAPIST) }; // exactly 48h... use a combo that hits 39 exactly instead
  // 39h exactly: 4x WHOLE_DAY (9.5h) = 38h, plus one MORNING (5h) = 43h - overshoot; build precisely:
  const exact39 = [WHOLE_DAY, WHOLE_DAY, WHOLE_DAY, WHOLE_DAY, { id: 'x', start: '10:00', end: '11:00', breakMinutes: 0 }]; // 9.5*4=38 + 1 = 39
  assert.deepEqual(weeklyCapViolations(staff, CAP_SETTING, { 1: exact39 }), []);
});

test('weeklyCapViolations: over the default cap is flagged with the correct overage', () => {
  const staff = [{ id: 1, weeklyHourCapOverride: null }];
  const assigned = { 1: [WHOLE_DAY, WHOLE_DAY, WHOLE_DAY, WHOLE_DAY, WHOLE_DAY] }; // 5 x 9.5h = 47.5h
  const violations = weeklyCapViolations(staff, CAP_SETTING, assigned);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].staffId, 1);
  assert.equal(violations[0].hoursWorked, 47.5);
  assert.equal(violations[0].capHours, 39);
  assert.equal(violations[0].overBy, 8.5);
});

test('weeklyCapViolations: an approved override is compliant under its own higher ceiling', () => {
  const staff = [{ id: 2, weeklyHourCapOverride: { approved: true, approvedAt: '2026-01-01', note: 'approved for extra hours', capHours: 45 } }];
  const assigned = { 2: Array(4).fill(WHOLE_DAY) }; // 38h, under their 45h ceiling
  assert.deepEqual(weeklyCapViolations(staff, CAP_SETTING, assigned), []);
});

test('weeklyCapViolations: an approved override still gets flagged once THEY exceed their own higher ceiling', () => {
  const staff = [{ id: 2, weeklyHourCapOverride: { approved: true, approvedAt: '2026-01-01', note: 'approved for extra hours', capHours: 45 } }];
  const assigned = { 2: Array(6).fill(WHOLE_DAY) }; // 57h - well over even their raised 45h ceiling
  const violations = weeklyCapViolations(staff, CAP_SETTING, assigned);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].capHours, 45);
  assert.equal(violations[0].overBy, 12);
});

test('weeklyCapViolations: only reports the people actually over their own effective cap', () => {
  const staff = [
    { id: 1, weeklyHourCapOverride: null }, // default 39h cap - will be over
    { id: 2, weeklyHourCapOverride: { approved: true, approvedAt: '2026-01-01', note: 'approved for extra hours', capHours: 45 } }, // 45h ceiling, compliant
    { id: 3, weeklyHourCapOverride: null }, // light week, compliant
  ];
  const assigned = {
    1: Array(5).fill(WHOLE_DAY), // 47.5h - over their 39h default cap
    2: Array(4).fill(WHOLE_DAY), // 38h - under their 45h ceiling, fine
    3: [MORNING], // 5h - fine
  };
  const violations = weeklyCapViolations(staff, CAP_SETTING, assigned);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].staffId, 1);
});

test('weeklyCapViolations: a staff member with no assignments this week is trivially compliant', () => {
  const staff = [{ id: 1, weeklyHourCapOverride: null }];
  assert.deepEqual(weeklyCapViolations(staff, CAP_SETTING, {}), []);
});

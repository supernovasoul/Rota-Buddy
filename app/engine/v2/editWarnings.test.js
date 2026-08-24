import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swapWarnings, undismissedWarnings } from './editWarnings.js';

const STAFF_MEMBER = { id: 's1', name: 'Ada', weeklyHourCapOverride: null };
const TARGET_SHIFT_TYPE = { id: 'st1', name: 'Whole day', start: '10:00', end: '16:00', breakMinutes: 0 }; // 6h paid, 6h span
const TARGET_DATE = '2026-08-03'; // a Monday - matches isoWeekday's Mon=0 scheme, so this IS its own week's start

function baseParams(overrides = {}) {
  return {
    staffId: 's1',
    targetDate: TARGET_DATE,
    targetShiftType: TARGET_SHIFT_TYPE,
    staffMember: STAFF_MEMBER,
    otherShiftsForStaff: [],
    weeklyHourCapSetting: { defaultCapHours: 39 },
    availability: [],
    availabilityPatterns: [],
    plannedRestWeeks: [],
    ...overrides,
  };
}

test('swapWarnings: no warnings when available, no rest week, no rest-gap breach, and well under cap', () => {
  assert.deepEqual(swapWarnings(baseParams()), []);
});

test('swapWarnings: warns when the person isn\'t marked available that date', () => {
  const warnings = swapWarnings(baseParams({
    availability: [{ staffId: 's1', dateFrom: TARGET_DATE, dateTo: TARGET_DATE, type: 'unavailable', note: '' }],
  }));
  assert.ok(warnings.some((w) => /isn't marked available/.test(w)));
});

test('swapWarnings: warns when the person is on a planned rest week that starts this week', () => {
  const warnings = swapWarnings(baseParams({
    plannedRestWeeks: [{ id: 'rw1', staffId: 's1', weekStart: TARGET_DATE, status: 'planned', note: '' }],
  }));
  assert.ok(warnings.some((w) => /rest week/.test(w)));
});

test('swapWarnings: a cancelled rest-week entry does not warn', () => {
  const warnings = swapWarnings(baseParams({
    plannedRestWeeks: [{ id: 'rw1', staffId: 's1', weekStart: TARGET_DATE, status: 'cancelled', note: '' }],
  }));
  assert.ok(!warnings.some((w) => /rest week/.test(w)));
});

test('swapWarnings: warns when the new shift leaves under 11h rest against another shift', () => {
  const warnings = swapWarnings(baseParams({
    // ends 23:30 the day before; target starts 10:00 - a 10.5h gap
    otherShiftsForStaff: [{ date: '2026-08-02', shiftType: { start: '09:00', end: '23:30', breakMinutes: 0 } }],
  }));
  assert.ok(warnings.some((w) => /rest/.test(w) && /11h minimum/.test(w)));
});

test('swapWarnings: a comfortable gap around the new shift does not warn about rest', () => {
  const warnings = swapWarnings(baseParams({
    otherShiftsForStaff: [{ date: '2026-08-02', shiftType: { start: '09:00', end: '17:00', breakMinutes: 0 } }],
  }));
  assert.ok(!warnings.some((w) => /11h minimum/.test(w)));
});

test('swapWarnings: warns when the new shift pushes the person\'s week over their cap', () => {
  const warnings = swapWarnings(baseParams({
    weeklyHourCapSetting: { defaultCapHours: 24 },
    otherShiftsForStaff: [
      { date: '2026-08-04', shiftType: { start: '09:00', end: '20:00', breakMinutes: 60 } }, // 10h paid
      { date: '2026-08-06', shiftType: { start: '09:00', end: '20:00', breakMinutes: 60 } }, // 10h paid
    ],
  }));
  assert.ok(warnings.some((w) => /26\.0h this week/.test(w) && /24h cap/.test(w)));
});

test('swapWarnings: an approved personal cap override is respected, not the default', () => {
  const warnings = swapWarnings(baseParams({
    staffMember: { ...STAFF_MEMBER, weeklyHourCapOverride: { approved: true, capHours: 50, approvedAt: '2026-01-01', note: '' } },
    weeklyHourCapSetting: { defaultCapHours: 24 },
    otherShiftsForStaff: [
      { date: '2026-08-04', shiftType: { start: '09:00', end: '20:00', breakMinutes: 60 } },
      { date: '2026-08-06', shiftType: { start: '09:00', end: '20:00', breakMinutes: 60 } },
    ],
  }));
  assert.ok(!warnings.some((w) => /cap/.test(w)), 'their approved 50h cap should not be exceeded by 26h');
});

test('swapWarnings: unrelated shifts outside this week don\'t count toward the weekly cap check', () => {
  const warnings = swapWarnings(baseParams({
    weeklyHourCapSetting: { defaultCapHours: 24 },
    otherShiftsForStaff: [{ date: '2026-07-20', shiftType: { start: '09:00', end: '23:00', breakMinutes: 0 } }], // a different week entirely
  }));
  assert.ok(!warnings.some((w) => /cap/.test(w)));
});

test('swapWarnings: multiple independent warnings can co-occur', () => {
  const warnings = swapWarnings(baseParams({
    availability: [{ staffId: 's1', dateFrom: TARGET_DATE, dateTo: TARGET_DATE, type: 'unavailable', note: '' }],
    plannedRestWeeks: [{ id: 'rw1', staffId: 's1', weekStart: TARGET_DATE, status: 'planned', note: '' }],
  }));
  assert.equal(warnings.length, 2);
});

test('undismissedWarnings: passes everything through when nothing has been dismissed', () => {
  assert.deepEqual(undismissedWarnings(['a', 'b']), ['a', 'b']);
});

test('undismissedWarnings: drops warnings that exactly match a dismissed string', () => {
  assert.deepEqual(undismissedWarnings(['a', 'b'], ['a']), ['b']);
});

test('undismissedWarnings: a genuinely new warning (never dismissed) still surfaces even if others were checked off', () => {
  assert.deepEqual(undismissedWarnings(['a', 'c'], ['a', 'b']), ['c']);
});

test('undismissedWarnings: dismissing everything results in no active warnings', () => {
  assert.deepEqual(undismissedWarnings(['a', 'b'], ['a', 'b']), []);
});

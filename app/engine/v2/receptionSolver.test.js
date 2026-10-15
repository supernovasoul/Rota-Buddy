import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReceptionDay, canAssign, feasibleAssignmentsForCombo, feasibleDayOptions, solveReceptionWeek } from './receptionSolver.js';
import { buildEligibility, datesOfWeek } from '../eligibility.js';
import { restViolations } from './restRule.js';

const MORNING = { id: 'm', name: 'Morning', start: '10:30', end: '15:30', breakMinutes: 0 }; // 5h paid
const LATE = { id: 'l', name: 'Late', start: '15:15', end: '21:00', breakMinutes: 30 }; // 5.25h paid
const WHOLE_DAY = { id: 'w', name: 'Whole day', start: '10:30', end: '21:00', breakMinutes: 60 }; // 9.5h paid
const WEEKEND_FULL_DAY = { id: 'we', name: 'Weekend full day', start: '08:30', end: '18:00', breakMinutes: 60 };

const SHIFT_TYPE_SETS = [{
  id: 'set1',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  receptionShiftTypes: [MORNING, LATE, WHOLE_DAY, WEEKEND_FULL_DAY],
  therapistShiftTypes: [],
}];

const OPENING_HOURS = {
  defaultWeekday: { start: '10:30', end: '21:00' },
  defaultWeekend: { start: '08:30', end: '18:00' },
  overrides: [{ date: '2026-08-06', start: '00:00', end: '00:00', closed: true, note: 'closed for refurb' }],
};

const CAP_SETTING = { defaultCapHours: 39 };

function noopEligibility() {
  return { isEligible: () => true };
}

test('resolveReceptionDay: weekday resolves the weekday span and finds both whole-day and split combos', () => {
  const day = resolveReceptionDay('2026-08-03', OPENING_HOURS, SHIFT_TYPE_SETS, false);
  assert.equal(day.closed, false);
  assert.equal(day.opening.start, '10:30');
  const names = day.combos.map((c) => c.map((t) => t.name).sort().join('+')).sort();
  assert.ok(names.includes('Whole day'));
  assert.ok(names.includes('Late+Morning'));
});

test('resolveReceptionDay: weekend resolves the weekend span and only the weekend full-day type covers it', () => {
  const day = resolveReceptionDay('2026-08-08', OPENING_HOURS, SHIFT_TYPE_SETS, true);
  assert.equal(day.opening.start, '08:30');
  assert.equal(day.combos.length, 1);
  assert.equal(day.combos[0][0].name, 'Weekend full day');
});

test('resolveReceptionDay: a closed override returns no combos and does not consult shiftTypeSets at all', () => {
  const day = resolveReceptionDay('2026-08-06', OPENING_HOURS, SHIFT_TYPE_SETS, false);
  assert.equal(day.closed, true);
  assert.deepEqual(day.combos, []);
});

test('resolveReceptionDay: throws rather than silently guessing when no shiftTypeSet covers the date', () => {
  assert.throws(() => resolveReceptionDay('2020-01-01', OPENING_HOURS, SHIFT_TYPE_SETS, false));
});

test('canAssign: blocks on plain eligibility (unavailable/not started/on leave)', () => {
  const person = { id: 1, weeklyHourCapOverride: null };
  const eligibility = { isEligible: () => false };
  const state = { assignedShifts: [], paidHoursSoFar: 0 };
  assert.equal(canAssign(person, WHOLE_DAY, '2026-08-03', state, eligibility, CAP_SETTING), false);
});

test('canAssign: allows a new shift with a genuinely compliant gap from the prior day\'s shift', () => {
  const person = { id: 1, weeklyHourCapOverride: null };
  const state = { assignedShifts: [{ date: '2026-08-02', start: '15:15', end: '21:00' }], paidHoursSoFar: 5.25 };
  // Morning starts 10:30 the next day, prior shift ended 21:00 -> 13.5h gap, compliant
  assert.equal(canAssign(person, MORNING, '2026-08-03', state, noopEligibility(), CAP_SETTING), true);
});

test('canAssign: blocks a new shift whose gap from the prior day\'s shift is under 11h', () => {
  const person = { id: 1, weeklyHourCapOverride: null };
  const state = { assignedShifts: [{ date: '2026-08-02', start: '15:15', end: '21:00' }], paidHoursSoFar: 5.25 };
  // an early type starting 05:00 the next day is only 8h after the prior shift ended 21:00 - violation
  const earlyType = { id: 'e', name: 'Very early', start: '05:00', end: '10:00', breakMinutes: 0 };
  assert.equal(canAssign(person, earlyType, '2026-08-03', state, noopEligibility(), CAP_SETTING), false);
});

test('canAssign: blocks when the new shift would push the person over their weekly cap', () => {
  const person = { id: 1, weeklyHourCapOverride: null };
  const state = { assignedShifts: [], paidHoursSoFar: 35 }; // already at 35h against a 39h cap
  assert.equal(canAssign(person, WHOLE_DAY, '2026-08-03', state, noopEligibility(), CAP_SETTING), false); // 35 + 9.5 = 44.5 > 39
});

test('canAssign: allows the new shift when it fits comfortably under eligibility, rest, and cap', () => {
  const person = { id: 1, weeklyHourCapOverride: null };
  const state = { assignedShifts: [], paidHoursSoFar: 10 };
  assert.equal(canAssign(person, WHOLE_DAY, '2026-08-03', state, noopEligibility(), CAP_SETTING), true);
});

test('canAssign: an approved higher cap allows a shift that would have been blocked under the default', () => {
  const person = { id: 1, weeklyHourCapOverride: { approved: true, approvedAt: '2026-01-01', note: 'approved', capHours: 45 } };
  const state = { assignedShifts: [], paidHoursSoFar: 35 };
  assert.equal(canAssign(person, WHOLE_DAY, '2026-08-03', state, noopEligibility(), CAP_SETTING), true); // 44.5 <= 45
});

test('feasibleAssignmentsForCombo: a whole-day combo can go to any single eligible person', () => {
  const receptionists = [{ id: 1, weeklyHourCapOverride: null }, { id: 2, weeklyHourCapOverride: null }];
  const results = feasibleAssignmentsForCombo([WHOLE_DAY], '2026-08-03', receptionists, {}, noopEligibility(), CAP_SETTING);
  assert.equal(results.length, 2); // either person 1 or person 2
  assert.ok(results.every((r) => r.length === 1));
});

test('feasibleAssignmentsForCombo: a split combo requires two DISTINCT people, never the same person twice', () => {
  const receptionists = [{ id: 1, weeklyHourCapOverride: null }, { id: 2, weeklyHourCapOverride: null }];
  const results = feasibleAssignmentsForCombo([MORNING, LATE], '2026-08-03', receptionists, {}, noopEligibility(), CAP_SETTING);
  for (const assignment of results) {
    const ids = assignment.map((a) => a.staffId);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate staff id within one assignment');
  }
  // both orderings possible: person1=Morning/person2=Late and vice versa
  assert.equal(results.length, 2);
});

test('feasibleAssignmentsForCombo: returns nothing when only one person is eligible for a two-person split', () => {
  const receptionists = [{ id: 1, weeklyHourCapOverride: null }, { id: 2, weeklyHourCapOverride: null }];
  const onlyPersonOneEligible = { isEligible: (id) => id === 1 };
  const results = feasibleAssignmentsForCombo([MORNING, LATE], '2026-08-03', receptionists, {}, onlyPersonOneEligible, CAP_SETTING);
  assert.equal(results.length, 0);
});

test('feasibleDayOptions: a closed day has no options at all', () => {
  const day = resolveReceptionDay('2026-08-06', OPENING_HOURS, SHIFT_TYPE_SETS, false);
  const receptionists = [{ id: 1, weeklyHourCapOverride: null }];
  const options = feasibleDayOptions(day, receptionists, {}, noopEligibility(), CAP_SETTING);
  assert.deepEqual(options, []);
});

test('feasibleDayOptions: reports zero options (a genuine gap) when nobody can safely cover any valid combo', () => {
  const day = resolveReceptionDay('2026-08-03', OPENING_HOURS, SHIFT_TYPE_SETS, false);
  const receptionists = [{ id: 1, weeklyHourCapOverride: null }];
  const noOneEligible = { isEligible: () => false };
  const options = feasibleDayOptions(day, receptionists, {}, noOneEligible, CAP_SETTING);
  assert.deepEqual(options, []);
});

test('feasibleDayOptions: a normal day with available staff produces both whole-day and split options', () => {
  const day = resolveReceptionDay('2026-08-03', OPENING_HOURS, SHIFT_TYPE_SETS, false);
  const receptionists = [{ id: 1, weeklyHourCapOverride: null }, { id: 2, weeklyHourCapOverride: null }];
  const options = feasibleDayOptions(day, receptionists, {}, noopEligibility(), CAP_SETTING);
  const wholeDayOptions = options.filter((o) => o.combo.length === 1);
  const splitOptions = options.filter((o) => o.combo.length === 2);
  assert.ok(wholeDayOptions.length > 0);
  assert.ok(splitOptions.length > 0);
});

// --- solveReceptionWeek: full week integration ---

const WEEK_DATES = datesOfWeek('2026-08-03'); // Mon 2026-08-03 .. Sun 2026-08-09
const NO_BALANCE = () => 0;
const NOT_EXEMPT = () => false;

test('solveReceptionWeek: two symmetric, fully-available receptionists cover every day with no hard-rule violations', () => {
  const receptionists = [{ id: 1, weeklyHourCapOverride: null }, { id: 2, weeklyHourCapOverride: null }];
  const eligibility = { isEligible: () => true };

  const result = solveReceptionWeek({
    dates: WEEK_DATES,
    openingHours: OPENING_HOURS,
    shiftTypeSets: SHIFT_TYPE_SETS,
    receptionists,
    eligibility,
    weeklyHourCapSetting: CAP_SETTING,
    existingBalance: NO_BALANCE,
    isExempt: NOT_EXEMPT,
  });

  // every day covered except the deliberate closed override on 2026-08-06 in this fixture's OPENING_HOURS
  for (const day of result.days) {
    if (day.date === '2026-08-06') {
      assert.equal(day.closed, true);
    } else {
      assert.equal(day.unfilled, false, `${day.date} should not be unfilled`);
    }
  }

  // hard rules: no rest violations, no cap breaches, for either person
  for (const s of receptionists) {
    const state = result.weekState[s.id];
    assert.deepEqual(restViolations(state.assignedShifts), [], `staff ${s.id} should have no rest violations`);
    assert.ok(state.paidHoursSoFar <= CAP_SETTING.defaultCapHours, `staff ${s.id} should stay under the weekly cap`);
  }

  // fairness + the cost tiebreaker: 6 open days (4 weekday, 2 weekend),
  // and with two fully symmetric, unconstrained people the cheapest way
  // to cover each one is always a single whole-day shift - 9.5h paid on
  // a weekday (Whole day), 8.5h paid on a weekend (Weekend full day) -
  // so total delivered hours should match that exactly, not the extra
  // ~0.75h/day a needless split would cost with no fairness benefit.
  const expectedTotal = 4 * 9.5 + 2 * 8.5;
  const total = result.weekState[1].paidHoursSoFar + result.weekState[2].paidHoursSoFar;
  assert.ok(Math.abs(total - expectedTotal) < 1e-9, `total delivered hours should match the cheapest whole-day-every-day total (${expectedTotal}), got ${total}`);
  const diff = Math.abs(result.weekState[1].paidHoursSoFar - result.weekState[2].paidHoursSoFar);
  assert.ok(diff <= 9.5, `hours should be reasonably balanced between two symmetric people, got a ${diff}h difference`);
});

test('solveReceptionWeek: a low weekly cap is never breached even when it forces the other person to cover more', () => {
  const receptionists = [
    { id: 1, weeklyHourCapOverride: { approved: true, approvedAt: '2026-01-01', note: 'part-time limit', capHours: 12 } },
    { id: 2, weeklyHourCapOverride: null },
  ];
  const eligibility = { isEligible: () => true };
  const threeDays = WEEK_DATES.slice(0, 3); // keep total demand (~28.5h) safely within person 2's 39h capacity alone

  const result = solveReceptionWeek({
    dates: threeDays,
    openingHours: OPENING_HOURS,
    shiftTypeSets: SHIFT_TYPE_SETS,
    receptionists,
    eligibility,
    weeklyHourCapSetting: CAP_SETTING,
    existingBalance: NO_BALANCE,
    isExempt: NOT_EXEMPT,
  });

  for (const day of result.days) assert.equal(day.unfilled, false);
  assert.ok(result.weekState[1].paidHoursSoFar <= 12, `capped person must never exceed their 12h ceiling, got ${result.weekState[1].paidHoursSoFar}`);
  assert.deepEqual(restViolations(result.weekState[1].assignedShifts), []);
  assert.deepEqual(restViolations(result.weekState[2].assignedShifts), []);
});

test('solveReceptionWeek: a day nobody is eligible for is reported as unfilled, not silently dropped or misassigned', () => {
  const receptionists = [{ id: 1, weeklyHourCapOverride: null }];
  // keep to 4 days so total demand (3 whole-days x 9.5h = 28.5h) stays
  // safely under the single receptionist's 39h default cap - otherwise
  // the cap itself would legitimately create MORE unfilled days than
  // just the deliberately-blocked one, which isn't what this test is checking
  const fourDays = WEEK_DATES.slice(0, 4);
  const blockedDate = fourDays[2];
  const eligibility = { isEligible: (id, date) => date !== blockedDate };

  const result = solveReceptionWeek({
    dates: fourDays,
    openingHours: OPENING_HOURS,
    shiftTypeSets: SHIFT_TYPE_SETS,
    receptionists,
    eligibility,
    weeklyHourCapSetting: CAP_SETTING,
    existingBalance: NO_BALANCE,
    isExempt: NOT_EXEMPT,
  });

  const blockedDay = result.days.find((d) => d.date === blockedDate);
  assert.equal(blockedDay.unfilled, true);
  assert.deepEqual(blockedDay.assignment, []);
  for (const day of result.days) {
    if (day.date !== blockedDate) assert.equal(day.unfilled, false);
  }
});

test('solveReceptionWeek: the cost tiebreaker never changes anyone\'s hours - it only picks a shape among fairness-tied options', () => {
  const receptionists = [
    { id: 1, weeklyHourCapOverride: null }, // can take whole days fine
    { id: 2, weeklyHourCapOverride: null }, // can take whole days fine
    // a 6h cap rules out the 9.5h whole-day type ENTIRELY - this person
    // can only ever fit a single ~5h split shift, once, for the whole week
    { id: 3, weeklyHourCapOverride: { approved: true, approvedAt: '2026-01-01', note: 'part-time limit', capHours: 6 } },
  ];
  const eligibility = { isEligible: () => true }; // plainly day-eligible every day - the constraint is purely the cap, not availability
  const fourWeekdays = datesOfWeek('2026-08-10').slice(0, 4); // a clean week with no closed overrides

  const withTiebreak = solveReceptionWeek({
    dates: fourWeekdays, openingHours: OPENING_HOURS, shiftTypeSets: SHIFT_TYPE_SETS,
    receptionists, eligibility, weeklyHourCapSetting: CAP_SETTING,
    existingBalance: NO_BALANCE, isExempt: NOT_EXEMPT,
  });
  const withoutTiebreak = solveReceptionWeek({
    dates: fourWeekdays, openingHours: OPENING_HOURS, shiftTypeSets: SHIFT_TYPE_SETS,
    receptionists, eligibility, weeklyHourCapSetting: CAP_SETTING,
    existingBalance: NO_BALANCE, isExempt: NOT_EXEMPT,
    costTiebreakWeight: 0,
  });

  // the capped person is always under-served relative to their entitlement
  // (they can never physically reach it), so fairness should hand them a
  // split shift regardless of the tiny cost penalty for using one
  assert.ok(withTiebreak.weekState[3].paidHoursSoFar > 0, 'the capped person should still receive a split shift when fairness calls for it');
  assert.ok(withTiebreak.weekState[3].paidHoursSoFar <= 6, 'never above their own cap');

  // the actual claim: fairness decides who/how much FIRST - identical
  // hours for every single person, with or without the cost tiebreaker.
  // If the tiebreaker changed this, it would mean cost is overriding
  // fairness rather than only breaking ties within it.
  for (const s of receptionists) {
    assert.equal(
      withTiebreak.weekState[s.id].paidHoursSoFar,
      withoutTiebreak.weekState[s.id].paidHoursSoFar,
      `staff ${s.id}'s total hours must be identical with/without the cost tiebreaker`
    );
  }
});

test('solveReceptionWeek: a closed-override day needs no coverage and is reported closed, not unfilled', () => {
  const receptionists = [{ id: 1, weeklyHourCapOverride: null }];
  const eligibility = { isEligible: () => true };

  const result = solveReceptionWeek({
    dates: WEEK_DATES,
    openingHours: OPENING_HOURS, // has a closed override on 2026-08-06, which falls in this week
    shiftTypeSets: SHIFT_TYPE_SETS,
    receptionists,
    eligibility,
    weeklyHourCapSetting: CAP_SETTING,
    existingBalance: NO_BALANCE,
    isExempt: NOT_EXEMPT,
  });

  const closedDay = result.days.find((d) => d.date === '2026-08-06');
  assert.equal(closedDay.closed, true);
  assert.equal(closedDay.unfilled, false);
  assert.deepEqual(closedDay.assignment, []);
});

// --- Slotted availability (early/later/full) actually constrains real assignment ---
// Closes the known gap noted in project memory: availability used to be
// day-level only, so the solver could put someone on a shift type that
// contradicted a stated single-shift preference. Shift types now carry
// .slot, and a receptionist's slotted pattern is checked against it.

test('canAssign: a real slotted-pattern eligibility blocks a shift type outside the ticked slot', () => {
  const morningWithSlot = { ...MORNING, slot: 'early' };
  const lateWithSlot = { ...LATE, slot: 'later' };
  const eligibility = buildEligibility({
    staff: [{ id: 1, startDate: '2020-01-01' }],
    availabilityPatterns: [
      { staffId: 1, dayOfWeek: 0, shiftSlot: 'early', available: true }, // Monday, early only
      { staffId: 1, dayOfWeek: 0, shiftSlot: 'later', available: false },
      { staffId: 1, dayOfWeek: 0, shiftSlot: 'full', available: false },
    ],
  });
  const person = { id: 1, weeklyHourCapOverride: null };
  const state = { assignedShifts: [], paidHoursSoFar: 0 };
  assert.equal(canAssign(person, morningWithSlot, '2026-08-03', state, eligibility, CAP_SETTING), true, 'ticked early - allowed');
  assert.equal(canAssign(person, lateWithSlot, '2026-08-03', state, eligibility, CAP_SETTING), false, 'never ticked later - blocked');
});

test('feasibleAssignmentsForCombo: only offers a split shift type to whoever actually ticked its slot', () => {
  const morningWithSlot = { ...MORNING, slot: 'early' };
  const lateWithSlot = { ...LATE, slot: 'later' };
  const eligibility = buildEligibility({
    staff: [{ id: 1, startDate: '2020-01-01' }, { id: 2, startDate: '2020-01-01' }],
    availabilityPatterns: [
      // staff 1: early only. staff 2: later only.
      { staffId: 1, dayOfWeek: 0, shiftSlot: 'early', available: true },
      { staffId: 1, dayOfWeek: 0, shiftSlot: 'later', available: false },
      { staffId: 1, dayOfWeek: 0, shiftSlot: 'full', available: false },
      { staffId: 2, dayOfWeek: 0, shiftSlot: 'early', available: false },
      { staffId: 2, dayOfWeek: 0, shiftSlot: 'later', available: true },
      { staffId: 2, dayOfWeek: 0, shiftSlot: 'full', available: false },
    ],
  });
  const receptionists = [{ id: 1, weeklyHourCapOverride: null }, { id: 2, weeklyHourCapOverride: null }];
  const results = feasibleAssignmentsForCombo([morningWithSlot, lateWithSlot], '2026-08-03', receptionists, {}, eligibility, CAP_SETTING);
  assert.equal(results.length, 1, 'only one valid pairing - staff 1 on early, staff 2 on later');
  const byShiftType = Object.fromEntries(results[0].map((a) => [a.shiftType.slot, a.staffId]));
  assert.equal(byShiftType.early, 1);
  assert.equal(byShiftType.later, 2);
});

test('feasibleAssignmentsForCombo: a pasted "early only" date override pairs people by the slot they offered', () => {
  const morningWithSlot = { ...MORNING, slot: 'early' };
  const lateWithSlot = { ...LATE, slot: 'later' };
  const eligibility = buildEligibility({
    staff: [{ id: 1, startDate: '2020-01-01' }, { id: 2, startDate: '2020-01-01' }],
    availability: [
      { id: 'a', staffId: 1, dateFrom: '2026-08-03', dateTo: '2026-08-03', type: 'available', shiftSlots: ['early'] },
      { id: 'b', staffId: 2, dateFrom: '2026-08-03', dateTo: '2026-08-03', type: 'available', shiftSlots: ['later'] },
    ],
  });
  const receptionists = [{ id: 1, weeklyHourCapOverride: null }, { id: 2, weeklyHourCapOverride: null }];
  const results = feasibleAssignmentsForCombo([morningWithSlot, lateWithSlot], '2026-08-03', receptionists, {}, eligibility, CAP_SETTING);
  assert.equal(results.length, 1);
  const byShiftType = Object.fromEntries(results[0].map((a) => [a.shiftType.slot, a.staffId]));
  assert.equal(byShiftType.early, 1);
  assert.equal(byShiftType.later, 2);
});

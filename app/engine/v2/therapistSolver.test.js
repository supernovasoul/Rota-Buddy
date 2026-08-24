import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTherapistDay, feasibleDayOptions, solveTherapistWeek } from './therapistSolver.js';
import { buildTherapistEntitlement } from './therapistFairness.js';
import { datesOfWeek } from '../eligibility.js';
import { restViolations } from './restRule.js';

const SIX_HOUR = { id: 's', name: 'Short', start: '10:00', end: '16:00', breakMinutes: 0 }; // 6h paid
const NINE_HOUR = { id: 'l', name: 'Long', start: '11:00', end: '20:30', breakMinutes: 30 }; // 9h paid

const SHIFT_TYPE_SETS = [{
  id: 'set1',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  receptionShiftTypes: [],
  therapistShiftTypes: [SIX_HOUR, NINE_HOUR],
}];

const OPENING_HOURS = {
  defaultWeekday: { start: '10:00', end: '20:30' },
  defaultWeekend: { start: '10:00', end: '20:30' },
  overrides: [{ date: '2026-08-06', start: '00:00', end: '00:00', closed: true, note: 'closed for refurb' }],
};

const CAP_SETTING = { defaultCapHours: 39 };

function noopEligibility() {
  return { isEligible: () => true };
}

const NO_BALANCE = () => 0;
const NOT_EXEMPT = () => false;

test('resolveTherapistDay: an open day carries the raw demand and every configured therapist shift type', () => {
  const day = resolveTherapistDay('2026-08-03', OPENING_HOURS, SHIFT_TYPE_SETS, false, 12);
  assert.equal(day.closed, false);
  assert.equal(day.demandHours, 12);
  assert.deepEqual(day.shiftTypes, [SIX_HOUR, NINE_HOUR]);
});

test('resolveTherapistDay: a closed override needs no therapists and carries zero demand regardless of what was passed in', () => {
  const day = resolveTherapistDay('2026-08-06', OPENING_HOURS, SHIFT_TYPE_SETS, false, 20);
  assert.equal(day.closed, true);
  assert.equal(day.demandHours, 0);
  assert.deepEqual(day.shiftTypes, []);
});

test('resolveTherapistDay: throws rather than silently guessing when no shiftTypeSet covers the date', () => {
  assert.throws(() => resolveTherapistDay('2020-01-01', OPENING_HOURS, SHIFT_TYPE_SETS, false, 10));
});

test('feasibleDayOptions: a closed day has no options at all', () => {
  const day = resolveTherapistDay('2026-08-06', OPENING_HOURS, SHIFT_TYPE_SETS, false, 20);
  const therapists = [{ id: 1, proportionalFraction: 1, weeklyHourCapOverride: null }];
  const options = feasibleDayOptions(day, therapists, {}, noopEligibility(), CAP_SETTING, { entitlement: {}, existingBalance: NO_BALANCE });
  assert.deepEqual(options, []);
});

test('feasibleDayOptions: someone already well over their fair share gets no shift at all', () => {
  const day = { date: '2026-08-03', closed: false, demandHours: 12, shiftTypes: [SIX_HOUR, NINE_HOUR] };
  const therapists = [{ id: 1, proportionalFraction: 1, weeklyHourCapOverride: null }];
  const entitlement = { 1: { THER_HOURS: 5 } };
  const weekState = { 1: { assignedShifts: [], paidHoursSoFar: 20 } }; // already 15h above their 5h entitlement
  const options = feasibleDayOptions(day, therapists, weekState, noopEligibility(), CAP_SETTING, { entitlement, existingBalance: NO_BALANCE });
  assert.equal(options.length, 1);
  assert.deepEqual(options[0].assignment, []);
});

test('feasibleDayOptions: a big deficit gets the longer shift, a small deficit gets the shorter one', () => {
  const day = { date: '2026-08-03', closed: false, demandHours: 20, shiftTypes: [SIX_HOUR, NINE_HOUR] };
  const therapists = [
    { id: 1, proportionalFraction: 1, weeklyHourCapOverride: null }, // 10h behind
    { id: 2, proportionalFraction: 1, weeklyHourCapOverride: null }, // 5h behind
  ];
  const entitlement = { 1: { THER_HOURS: 10 }, 2: { THER_HOURS: 5 } };
  const options = feasibleDayOptions(day, therapists, {}, noopEligibility(), CAP_SETTING, { entitlement, existingBalance: NO_BALANCE });
  assert.equal(options.length, 1);
  const byStaff = Object.fromEntries(options[0].assignment.map((a) => [a.staffId, a.shiftType]));
  // person 1: |{-10+6}|=4 vs |{-10+9}|=1 -> the 9h shift is strictly closer
  assert.equal(byStaff[1].name, 'Long');
  // person 2: no-shift=5, |{-5+6}|=1, |{-5+9}|=4 -> the 6h shift is strictly closer (and beats not working at all)
  assert.equal(byStaff[2].name, 'Short');
});

test('feasibleDayOptions: an exact tie between two lengths is broken in favour of the cheaper (shorter) one', () => {
  // dev = -1.5: |{-1.5+6}| = 4.5, and a shift long enough to land exactly
  // as far on the other side ties it - construct one at 3h (|{-1.5+3}|=1.5,
  // not a tie); instead use the "no shift vs longest shift" tie directly:
  // dev = -6 exactly matches the 6h shift's gain -> |{-6+6}| = 0, a clean win
  // over "no shift" (|{-6}| = 6) with nothing else competing - use a
  // genuine two-way tie instead: two therapists, one whose deficit sits
  // exactly halfway between the two shift lengths (7.5h behind -> 6h
  // shift scores |{-7.5+6}|=1.5, 9h shift scores |{-7.5+9}|=1.5, a tie).
  const day = { date: '2026-08-03', closed: false, demandHours: 20, shiftTypes: [SIX_HOUR, NINE_HOUR] };
  const therapists = [{ id: 1, proportionalFraction: 1, weeklyHourCapOverride: null }];
  const entitlement = { 1: { THER_HOURS: 7.5 } };
  const options = feasibleDayOptions(day, therapists, {}, noopEligibility(), CAP_SETTING, { entitlement, existingBalance: NO_BALANCE });
  assert.equal(options[0].assignment[0].shiftType.name, 'Short', 'a genuine tie should prefer the cheaper (shorter) shift');
});

test('feasibleDayOptions: a shift that would breach eligibility, rest, or the weekly cap is excluded from that person\'s own choice', () => {
  const day = { date: '2026-08-03', closed: false, demandHours: 20, shiftTypes: [SIX_HOUR, NINE_HOUR] };
  const therapists = [{ id: 1, proportionalFraction: 1, weeklyHourCapOverride: null }];
  const entitlement = { 1: { THER_HOURS: 20 } }; // very behind, would want the 9h shift
  const weekState = { 1: { assignedShifts: [], paidHoursSoFar: 34 } }; // 34 + 9 = 43 > 39 cap, but 34 + 6 = 40 also breaches
  const options = feasibleDayOptions(day, therapists, weekState, noopEligibility(), CAP_SETTING, { entitlement, existingBalance: NO_BALANCE });
  assert.deepEqual(options[0].assignment, [], 'neither shift fits under the cap, so this person gets nothing today, not an over-cap shift');
});

test('feasibleDayOptions: two therapists are scheduled entirely independently - no shared "one desk" constraint', () => {
  const day = { date: '2026-08-03', closed: false, demandHours: 20, shiftTypes: [SIX_HOUR, NINE_HOUR] };
  const therapists = [
    { id: 1, proportionalFraction: 1, weeklyHourCapOverride: null },
    { id: 2, proportionalFraction: 1, weeklyHourCapOverride: null },
  ];
  const entitlement = { 1: { THER_HOURS: 10 }, 2: { THER_HOURS: 10 } };
  const options = feasibleDayOptions(day, therapists, {}, noopEligibility(), CAP_SETTING, { entitlement, existingBalance: NO_BALANCE });
  // both should independently get the 9h shift (|{-10+9}|=1 beats |{-10+6}|=4) - nothing stops them working the same day together
  assert.equal(options[0].assignment.length, 2);
  for (const a of options[0].assignment) assert.equal(a.shiftType.name, 'Long');
});

// --- solveTherapistWeek: full week integration ---

const WEEK_DATES = datesOfWeek('2026-08-03'); // Mon 2026-08-03 .. Sun 2026-08-09
const FLAT_DEMAND = WEEK_DATES.map((date) => ({ date, forecastHours: 15, overrideHours: null }));

test('solveTherapistWeek: two symmetric, fully-available therapists end up close to evenly balanced with no hard-rule violations', () => {
  const therapists = [
    { id: 1, proportionalFraction: 1, weeklyHourCapOverride: null },
    { id: 2, proportionalFraction: 1, weeklyHourCapOverride: null },
  ];
  const eligibility = { isEligible: () => true };

  const result = solveTherapistWeek({
    dates: WEEK_DATES,
    openingHours: OPENING_HOURS,
    shiftTypeSets: SHIFT_TYPE_SETS,
    therapists,
    eligibility,
    weeklyHourCapSetting: CAP_SETTING,
    demand: FLAT_DEMAND,
    existingBalance: NO_BALANCE,
    isExempt: NOT_EXEMPT,
  });

  for (const t of therapists) {
    const state = result.weekState[t.id];
    assert.deepEqual(restViolations(state.assignedShifts), [], `therapist ${t.id} should have no rest violations`);
    assert.ok(state.paidHoursSoFar <= CAP_SETTING.defaultCapHours, `therapist ${t.id} should stay under the weekly cap`);
  }

  const diff = Math.abs(result.weekState[1].paidHoursSoFar - result.weekState[2].paidHoursSoFar);
  assert.ok(diff <= 9, `two symmetric people should end up reasonably balanced, got a ${diff}h difference`);

  const closedDay = result.days.find((d) => d.date === '2026-08-06');
  assert.equal(closedDay.closed, true);
  assert.deepEqual(closedDay.assignment, []);
});

test('solveTherapistWeek: someone starting with a large negative ledger balance (e.g. back from a rest week) is caught up ahead of someone at zero', () => {
  const therapists = [
    { id: 1, proportionalFraction: 1, weeklyHourCapOverride: null }, // behind by 20h coming in
    { id: 2, proportionalFraction: 1, weeklyHourCapOverride: null }, // at zero
  ];
  const eligibility = { isEligible: () => true };
  const existingBalance = (staffId, dim) => (staffId === 1 && dim === 'THER_HOURS' ? -20 : 0);
  // a generous cap here so the catch-up itself is what's being tested,
  // not an incidental cap ceiling both people would hit regardless
  const GENEROUS_CAP = { defaultCapHours: 60 };

  const result = solveTherapistWeek({
    dates: WEEK_DATES,
    openingHours: OPENING_HOURS,
    shiftTypeSets: SHIFT_TYPE_SETS,
    therapists,
    eligibility,
    weeklyHourCapSetting: GENEROUS_CAP,
    demand: FLAT_DEMAND,
    existingBalance,
    isExempt: NOT_EXEMPT,
  });

  assert.ok(
    result.weekState[1].paidHoursSoFar > result.weekState[2].paidHoursSoFar,
    'the person catching up from a rest week should get more hours than the person already at zero'
  );
  // person 2 (starting at zero, entitled to 45h) can hit their entitlement
  // exactly with 5 Long days - a clean, unambiguous target
  assert.ok(Math.abs(result.weekState[2].paidHoursSoFar - 45) < 1e-9, `person 2 should land almost exactly on their own entitlement, got ${result.weekState[2].paidHoursSoFar}`);
  // person 1 (20h behind, same 45h entitlement) should work every available
  // day at the longer length - the most this one week's capacity allows -
  // since even maxing out still leaves them short of fully catching up
  assert.equal(result.weekState[1].paidHoursSoFar, 54, `person 1 should max out available capacity (6 open days x 9h) while catching up, got ${result.weekState[1].paidHoursSoFar}`);
});

test('solveTherapistWeek: proportional fraction shares raw demand fairly between a full-time and a half-time therapist', () => {
  const therapists = [
    { id: 1, proportionalFraction: 1.0, weeklyHourCapOverride: null },
    { id: 2, proportionalFraction: 0.5, weeklyHourCapOverride: null },
  ];
  const eligibility = { isEligible: () => true };

  const result = solveTherapistWeek({
    dates: WEEK_DATES,
    openingHours: OPENING_HOURS,
    shiftTypeSets: SHIFT_TYPE_SETS,
    therapists,
    eligibility,
    weeklyHourCapSetting: CAP_SETTING,
    demand: FLAT_DEMAND,
    existingBalance: NO_BALANCE,
    isExempt: NOT_EXEMPT,
  });

  // person 1 is entitled to roughly double person 2's share of the same demand
  assert.ok(
    result.weekState[1].paidHoursSoFar > result.weekState[2].paidHoursSoFar,
    'the full-time therapist should end up with more hours than the half-time one'
  );
});

test('solveTherapistWeek: a low weekly cap is never breached even though it leaves that person under-served', () => {
  const therapists = [
    { id: 1, proportionalFraction: 1, weeklyHourCapOverride: { approved: true, approvedAt: '2026-01-01', note: 'part-time limit', capHours: 6 } },
    { id: 2, proportionalFraction: 1, weeklyHourCapOverride: null },
  ];
  const eligibility = { isEligible: () => true };

  const result = solveTherapistWeek({
    dates: WEEK_DATES,
    openingHours: OPENING_HOURS,
    shiftTypeSets: SHIFT_TYPE_SETS,
    therapists,
    eligibility,
    weeklyHourCapSetting: CAP_SETTING,
    demand: FLAT_DEMAND,
    existingBalance: NO_BALANCE,
    isExempt: NOT_EXEMPT,
  });

  assert.ok(result.weekState[1].paidHoursSoFar <= 6, `capped therapist must never exceed their 6h ceiling, got ${result.weekState[1].paidHoursSoFar}`);
  assert.deepEqual(restViolations(result.weekState[1].assignedShifts), []);
  assert.deepEqual(restViolations(result.weekState[2].assignedShifts), []);
});

test('solveTherapistWeek: someone ineligible all week (e.g. on a planned rest week) simply falls behind, ready to be caught up later', () => {
  const therapists = [
    { id: 1, proportionalFraction: 1, weeklyHourCapOverride: null }, // on a rest week
    { id: 2, proportionalFraction: 1, weeklyHourCapOverride: null },
  ];
  const eligibility = { isEligible: (id) => id !== 1 };

  const result = solveTherapistWeek({
    dates: WEEK_DATES,
    openingHours: OPENING_HOURS,
    shiftTypeSets: SHIFT_TYPE_SETS,
    therapists,
    eligibility,
    weeklyHourCapSetting: CAP_SETTING,
    demand: FLAT_DEMAND,
    existingBalance: NO_BALANCE,
    isExempt: NOT_EXEMPT,
  });

  assert.equal(result.weekState[1].paidHoursSoFar, 0, 'someone ineligible all week should get zero shifts, not an error or a silent override');
  assert.deepEqual(result.weekState[1].assignedShifts, []);
});

test('solveTherapistWeek: entitlement reflects only the days/pool the fixture actually describes (sanity-checks against buildTherapistEntitlement directly)', () => {
  const therapists = [{ id: 1, proportionalFraction: 1, weeklyHourCapOverride: null }];
  const eligibility = { isEligible: () => true };
  const dayContexts = WEEK_DATES.map((date) => ({ date, closed: date === '2026-08-06', isWeekend: false, demandHours: date === '2026-08-06' ? 0 : 15 }));
  const expected = buildTherapistEntitlement(dayContexts, therapists, eligibility);

  const result = solveTherapistWeek({
    dates: WEEK_DATES,
    openingHours: OPENING_HOURS,
    shiftTypeSets: SHIFT_TYPE_SETS,
    therapists,
    eligibility,
    weeklyHourCapSetting: CAP_SETTING,
    demand: FLAT_DEMAND,
    existingBalance: NO_BALANCE,
    isExempt: NOT_EXEMPT,
  });

  assert.ok(Math.abs(result.entitlement[1].THER_HOURS - expected[1].THER_HOURS) < 1e-9);
});

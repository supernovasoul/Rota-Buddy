import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveChainedWeeks } from './chainedWeeks.js';

const WHOLE_DAY = { id: 'w', name: 'Whole day', start: '10:30', end: '21:00', breakMinutes: 60 };
const SIX_HOUR = { id: 's', name: 'Short', start: '10:00', end: '16:00', breakMinutes: 0 };
const NINE_HOUR = { id: 'l', name: 'Long', start: '11:00', end: '20:30', breakMinutes: 30 };

const SHIFT_TYPE_SETS = [{
  id: 'set1', effectiveFrom: '2020-01-01', effectiveTo: null,
  receptionShiftTypes: [WHOLE_DAY],
  therapistShiftTypes: [SIX_HOUR, NINE_HOUR],
}];

const OPENING_HOURS = {
  defaultWeekday: { start: '10:30', end: '21:00' },
  defaultWeekend: { start: '10:30', end: '21:00' },
  overrides: [],
};

const CAP_SETTING = { defaultCapHours: 60 }; // generous, so the cap never masks the chaining behaviour under test
const NOT_EXEMPT = () => false;

test('solveChainedWeeks: a starting ledger deficit is honoured from week 1 (real history)', () => {
  const receptionists = [
    { id: 1, weeklyHourCapOverride: null }, // 20h behind per real ledger history
    { id: 2, weeklyHourCapOverride: null },
  ];
  const eligibility = { isEligible: () => true };
  const ledgerEvents = [
    { id: 'e1', staffId: 1, dimensionId: 'REC_HOURS', periodId: 'p0', entitled: 30, actual: 10, eventType: 'period_close', note: '', createdAt: '2026-07-01' },
  ];

  const result = solveChainedWeeks({
    weekStarts: ['2026-08-03'],
    openingHours: OPENING_HOURS, shiftTypeSets: SHIFT_TYPE_SETS,
    receptionists, therapists: [], eligibility, weeklyHourCapSetting: CAP_SETTING,
    demand: [], ledgerEvents, isExempt: NOT_EXEMPT,
  });

  assert.equal(result.weeks.length, 1);
  assert.ok(
    result.weeks[0].reception.weekState[1].paidHoursSoFar >= result.weeks[0].reception.weekState[2].paidHoursSoFar,
    'the person behind per real ledger history should get at least as much as the person at zero'
  );
});

test('solveChainedWeeks: a within-generation deficit (no real ledger event at all) is correctly carried forward into the running balance week over week', () => {
  // a single therapist, capacity-constrained by shift-length granularity
  // (see therapistSolver.test.js's equivalent single-person case) so a
  // real, deterministic deviation accrues each week purely from this
  // generation pass - nothing here ever touches ledgerEvents.
  const therapists = [{ id: 1, proportionalFraction: 1, weeklyHourCapOverride: null }];
  const eligibility = { isEligible: () => true };
  const demand = [
    ...['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09'].map((date) => ({ date, forecastHours: 15, overrideHours: null })),
    ...['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16'].map((date) => ({ date, forecastHours: 15, overrideHours: null })),
  ];

  const result = solveChainedWeeks({
    weekStarts: ['2026-08-03', '2026-08-10'],
    openingHours: OPENING_HOURS, shiftTypeSets: SHIFT_TYPE_SETS,
    receptionists: [], therapists, eligibility, weeklyHourCapSetting: CAP_SETTING,
    demand, ledgerEvents: [], isExempt: NOT_EXEMPT,
  });

  assert.equal(result.weeks.length, 2);
  const week1Dev = result.weeks[0].therapist.weekState[1].paidHoursSoFar - result.weeks[0].therapist.entitlement[1].THER_HOURS;
  const week2Dev = result.weeks[1].therapist.weekState[1].paidHoursSoFar - result.weeks[1].therapist.entitlement[1].THER_HOURS;

  // the running balance after both weeks must equal exactly the sum of
  // each week's own deviation - proving week 2's solve genuinely saw
  // week 1's outcome as its existingBalance input, entirely as a draft
  assert.ok(Math.abs(result.finalBalance(1, 'THER_HOURS') - (week1Dev + week2Dev)) < 1e-9);
});

test('solveChainedWeeks: reception and therapist chains are tracked independently per staff member', () => {
  const receptionists = [{ id: 1, weeklyHourCapOverride: null }];
  const therapists = [{ id: 2, proportionalFraction: 1, weeklyHourCapOverride: null }];
  const eligibility = { isEligible: () => true };

  const result = solveChainedWeeks({
    weekStarts: ['2026-08-03'],
    openingHours: OPENING_HOURS, shiftTypeSets: SHIFT_TYPE_SETS,
    receptionists, therapists, eligibility, weeklyHourCapSetting: CAP_SETTING,
    demand: [{ date: '2026-08-03', forecastHours: 10, overrideHours: null }], ledgerEvents: [], isExempt: NOT_EXEMPT,
  });

  assert.equal(result.finalBalance(2, 'REC_HOURS'), 0, 'a therapist should never accumulate a reception-dimension balance');
  assert.equal(result.finalBalance(1, 'THER_HOURS'), 0, 'a receptionist should never accumulate a therapist-dimension balance');
});

test('solveChainedWeeks: a day nobody can cover is still reported as a genuine reception gap, not silently dropped', () => {
  const receptionists = [{ id: 1, weeklyHourCapOverride: null }];
  const eligibility = { isEligible: (id, date) => date !== '2026-08-05' };

  const result = solveChainedWeeks({
    weekStarts: ['2026-08-03'],
    openingHours: OPENING_HOURS, shiftTypeSets: SHIFT_TYPE_SETS,
    receptionists, therapists: [], eligibility, weeklyHourCapSetting: CAP_SETTING,
    demand: [], ledgerEvents: [], isExempt: NOT_EXEMPT,
  });

  const blockedDay = result.weeks[0].reception.days.find((d) => d.date === '2026-08-05');
  assert.equal(blockedDay.unfilled, true);
});

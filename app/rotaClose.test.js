import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closePeriod } from './rotaClose.js';

const WHOLE_DAY = { id: 'st-w', name: 'Whole day', start: '10:00', end: '16:00', breakMinutes: 0 }; // 6h paid, exactly spans opening hours every day
const THERAPIST_TYPE = { id: 'st-t', name: 'Weekday', start: '10:00', end: '16:00', breakMinutes: 0 }; // 6h paid

const OPENING_HOURS = {
  defaultWeekday: { start: '10:00', end: '16:00' },
  defaultWeekend: { start: '10:00', end: '16:00' },
  overrides: [],
};
const SHIFT_TYPE_SETS = [{ id: 'set1', effectiveFrom: '2020-01-01', effectiveTo: null, receptionShiftTypes: [WHOLE_DAY], therapistShiftTypes: [THERAPIST_TYPE] }];

let idCounter = 0;
function newId() { return `id-${idCounter++}`; }

function baseState(overrides = {}) {
  return {
    staff: [],
    availabilityPatterns: [],
    availability: [],
    openingHours: OPENING_HOURS,
    shiftTypeSets: SHIFT_TYPE_SETS,
    weeklyHourCapSetting: { defaultCapHours: 60 },
    demand: [],
    rotaPeriods: [],
    shifts: [],
    assignments: [],
    ledgerEvents: [],
    plannedRestWeeks: [],
    forcedOff: [],
    ...overrides,
  };
}

function receptionShift(id, periodId, date) {
  return { id, periodId, date, shiftTypeId: WHOLE_DAY.id, roleRequired: 'receptionist', isShadowSlot: false, shadowOfShiftId: null };
}
function assignment(id, shiftId, staffId, plannedHours) {
  return { id, shiftId, staffId, status: 'assigned', plannedHours, actualHours: null, changeReason: null, changedAt: null };
}

test('closePeriod: banks entitled and actual hours correctly for reception (including the weekend-only dimension)', () => {
  const period = { id: 'p1', startDate: '2026-08-03', endDate: '2026-08-09', status: 'draft', closedAt: null, closedBy: null };
  const dates = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09'];
  // r1 works every day (incl. both weekend days); r2 works nothing
  const shifts = dates.map((d, i) => receptionShift(`shift-${i}`, 'p1', d));
  const assignments = shifts.map((s, i) => assignment(`a-${i}`, s.id, 'r1', 6));

  const state = baseState({
    staff: [{ id: 'r1', role: 'receptionist', startDate: '2020-01-01', endDate: null }, { id: 'r2', role: 'receptionist', startDate: '2020-01-01', endDate: null }],
    rotaPeriods: [period], shifts, assignments,
  });

  const result = closePeriod(state, 'p1', newId, '2026-08-10T00:00:00Z');

  const r1Hours = result.ledgerEvents.find((e) => e.staffId === 'r1' && e.dimensionId === 'REC_HOURS');
  assert.equal(r1Hours.entitled, 21); // 6h reference cost / 2 people x 7 days = 21
  assert.equal(r1Hours.actual, 42); // 7 days x 6h

  const r1Weekend = result.ledgerEvents.find((e) => e.staffId === 'r1' && e.dimensionId === 'REC_WEEKEND');
  assert.equal(r1Weekend.entitled, 6); // 6h / 2 people x 2 weekend days
  assert.equal(r1Weekend.actual, 12); // 2 weekend days x 6h

  const r2Hours = result.ledgerEvents.find((e) => e.staffId === 'r2' && e.dimensionId === 'REC_HOURS');
  assert.equal(r2Hours.entitled, 21, 'r2 was still entitled to a share even though they worked none of it');
  assert.equal(r2Hours.actual, 0);
});

test('closePeriod: banks entitled and actual hours for a therapist dimension', () => {
  const period = { id: 'p1', startDate: '2026-08-03', endDate: '2026-08-09', status: 'draft', closedAt: null, closedBy: null };
  const dates = ['2026-08-03', '2026-08-04', '2026-08-05'];
  const shifts = dates.map((d, i) => ({ id: `ts-${i}`, periodId: 'p1', date: d, shiftTypeId: THERAPIST_TYPE.id, roleRequired: 'therapist', isShadowSlot: false, shadowOfShiftId: null }));
  const assignments = shifts.map((s, i) => assignment(`ta-${i}`, s.id, 't1', 6));

  const state = baseState({
    staff: [{ id: 't1', role: 'therapist', proportionalFraction: 1, startDate: '2020-01-01', endDate: null }],
    demand: dates.map((d) => ({ date: d, forecastHours: 6, overrideHours: null })),
    rotaPeriods: [period], shifts, assignments,
  });

  const result = closePeriod(state, 'p1', newId, '2026-08-10T00:00:00Z');
  const event = result.ledgerEvents.find((e) => e.staffId === 't1' && e.dimensionId === 'THER_HOURS');
  assert.equal(event.entitled, 18); // sole eligible therapist, full demand each day: 6+6+6
  assert.equal(event.actual, 18);
});

test('closePeriod: marks every assignment in the period as worked, with actualHours filled in from plannedHours', () => {
  const period = { id: 'p1', startDate: '2026-08-03', endDate: '2026-08-09', status: 'draft', closedAt: null, closedBy: null };
  const shift = receptionShift('s1', 'p1', '2026-08-03');
  const state = baseState({
    staff: [{ id: 'r1', role: 'receptionist', startDate: '2020-01-01', endDate: null }],
    rotaPeriods: [period], shifts: [shift], assignments: [assignment('a1', 's1', 'r1', 6)],
  });

  const result = closePeriod(state, 'p1', newId, '2026-08-10T00:00:00Z');
  const updated = result.assignments.find((a) => a.id === 'a1');
  assert.equal(updated.status, 'worked');
  assert.equal(updated.actualHours, 6);
});

test('closePeriod: leaves a manager-set cancelled assignment cancelled, banking its 0 actual hours (regression: the fix no longer stomps status back to worked)', () => {
  const period = { id: 'p1', startDate: '2026-08-03', endDate: '2026-08-09', status: 'draft', closedAt: null, closedBy: null };
  const shift = receptionShift('s1', 'p1', '2026-08-03');
  const cancelled = { id: 'a1', shiftId: 's1', staffId: 'r1', status: 'cancelled', plannedHours: 6, actualHours: 0, changeReason: 'sick', changedAt: '2026-08-03T09:00:00Z' };
  const state = baseState({
    staff: [{ id: 'r1', role: 'receptionist', startDate: '2020-01-01', endDate: null }],
    rotaPeriods: [period], shifts: [shift], assignments: [cancelled],
  });

  const result = closePeriod(state, 'p1', newId, '2026-08-10T00:00:00Z');
  const updated = result.assignments.find((a) => a.id === 'a1');
  assert.equal(updated.status, 'cancelled', 'closing must not promote a cancelled assignment back to worked');
  assert.equal(updated.actualHours, 0);
  const event = result.ledgerEvents.find((e) => e.staffId === 'r1' && e.dimensionId === 'REC_HOURS');
  assert.equal(event.actual, 0, 'the cancellation must bank as zero actual hours');
});

test('closePeriod: leaves a manager-set reduced assignment reduced, banking its partial actual hours', () => {
  const period = { id: 'p1', startDate: '2026-08-03', endDate: '2026-08-09', status: 'draft', closedAt: null, closedBy: null };
  const shift = receptionShift('s1', 'p1', '2026-08-03');
  const reduced = { id: 'a1', shiftId: 's1', staffId: 'r1', status: 'reduced', plannedHours: 6, actualHours: 4, changeReason: 'low bookings', changedAt: '2026-08-03T09:00:00Z' };
  const state = baseState({
    staff: [{ id: 'r1', role: 'receptionist', startDate: '2020-01-01', endDate: null }],
    rotaPeriods: [period], shifts: [shift], assignments: [reduced],
  });

  const result = closePeriod(state, 'p1', newId, '2026-08-10T00:00:00Z');
  const updated = result.assignments.find((a) => a.id === 'a1');
  assert.equal(updated.status, 'reduced', 'closing must not promote a reduced assignment back to worked');
  assert.equal(updated.actualHours, 4);
  const event = result.ledgerEvents.find((e) => e.staffId === 'r1' && e.dimensionId === 'REC_HOURS');
  assert.equal(event.actual, 4, 'the reduction must bank its partial actual hours, not the full planned hours');
});

test('closePeriod: marks the period itself as closed with a timestamp', () => {
  const period = { id: 'p1', startDate: '2026-08-03', endDate: '2026-08-09', status: 'draft', closedAt: null, closedBy: null };
  const state = baseState({ staff: [], rotaPeriods: [period] });
  const result = closePeriod(state, 'p1', newId, '2026-08-10T00:00:00Z');
  assert.equal(result.rotaPeriods[0].status, 'closed');
  assert.equal(result.rotaPeriods[0].closedAt, '2026-08-10T00:00:00Z');
});

test('closePeriod: refuses to close a period that is already closed', () => {
  const period = { id: 'p1', startDate: '2026-08-03', endDate: '2026-08-09', status: 'closed', closedAt: '2026-08-10T00:00:00Z', closedBy: null };
  const state = baseState({ staff: [], rotaPeriods: [period] });
  assert.throws(() => closePeriod(state, 'p1', newId, '2026-08-11T00:00:00Z'), /already closed/);
});

test('closePeriod: throws clearly if the period id does not exist', () => {
  const state = baseState({});
  assert.throws(() => closePeriod(state, 'nope', newId, '2026-08-10T00:00:00Z'), /no longer exists/);
});

test('closePeriod: never touches a different period\'s shifts, assignments, or ledger', () => {
  const period1 = { id: 'p1', startDate: '2026-08-03', endDate: '2026-08-09', status: 'draft', closedAt: null, closedBy: null };
  const period2 = { id: 'p2', startDate: '2026-08-10', endDate: '2026-08-16', status: 'draft', closedAt: null, closedBy: null };
  const shift1 = receptionShift('s1', 'p1', '2026-08-03');
  const shift2 = receptionShift('s2', 'p2', '2026-08-10');
  const state = baseState({
    staff: [{ id: 'r1', role: 'receptionist', startDate: '2020-01-01', endDate: null }],
    rotaPeriods: [period1, period2],
    shifts: [shift1, shift2],
    assignments: [assignment('a1', 's1', 'r1', 6), assignment('a2', 's2', 'r1', 6)],
  });

  const result = closePeriod(state, 'p1', newId, '2026-08-10T00:00:00Z');
  assert.equal(result.rotaPeriods.find((p) => p.id === 'p2').status, 'draft', 'the other period should remain untouched');
  assert.equal(result.assignments.find((a) => a.id === 'a2').status, 'assigned', 'the other period\'s assignment should be untouched');
  assert.equal(result.ledgerEvents.every((e) => e.periodId === 'p1'), true, 'no ledger event should reference the other period');
});

test('closePeriod: someone with genuinely no stake in a dimension this period (zero entitled, zero actual) gets no ledger event at all', () => {
  const period = { id: 'p1', startDate: '2026-08-03', endDate: '2026-08-09', status: 'draft', closedAt: null, closedBy: null };
  // r2 is not eligible any day this week - not started yet
  const shift = receptionShift('s1', 'p1', '2026-08-03');
  const state = baseState({
    staff: [
      { id: 'r1', role: 'receptionist', startDate: '2020-01-01', endDate: null },
      { id: 'r2', role: 'receptionist', startDate: '2027-01-01', endDate: null },
    ],
    rotaPeriods: [period], shifts: [shift], assignments: [assignment('a1', 's1', 'r1', 6)],
  });

  const result = closePeriod(state, 'p1', newId, '2026-08-10T00:00:00Z');
  assert.equal(result.ledgerEvents.some((e) => e.staffId === 'r2'), false);
});

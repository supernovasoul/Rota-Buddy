import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodsOverlappingRange, saveChainedWeeksAsDraftPeriods } from './rotaPeriods.js';

const WHOLE_DAY = { id: 'st-w', name: 'Whole day', start: '10:30', end: '21:00', breakMinutes: 60 }; // 9.5h paid
const THERAPIST_TYPE = { id: 'st-t', name: 'Weekday', start: '11:00', end: '20:00', breakMinutes: 60 }; // 8h paid

let idCounter = 0;
function newId() { return `id-${idCounter++}`; }

function fakeWeek(weekStart, dates, receptionAssignmentsByDay, therapistAssignmentsByDay) {
  return {
    weekStart,
    dates,
    reception: { days: dates.map((date, i) => ({ date, closed: false, unfilled: false, assignment: receptionAssignmentsByDay[i] ?? [] })) },
    therapist: { days: dates.map((date, i) => ({ date, closed: false, assignment: therapistAssignmentsByDay[i] ?? [] })) },
  };
}

test('periodsOverlappingRange: finds periods that overlap at all, not just exact matches', () => {
  const periods = [{ id: 'p1', startDate: '2026-08-03', endDate: '2026-08-09', status: 'draft' }];
  assert.equal(periodsOverlappingRange(periods, '2026-08-03', '2026-08-09').length, 1);
  assert.equal(periodsOverlappingRange(periods, '2026-08-01', '2026-08-04').length, 1, 'a partial overlap still counts');
  assert.equal(periodsOverlappingRange(periods, '2026-08-10', '2026-08-16').length, 0, 'no overlap at all');
});

test('saveChainedWeeksAsDraftPeriods: creates one draft period per week with the right date range', () => {
  const dates = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09'];
  const result = { weeks: [fakeWeek('2026-08-03', dates, [], [])] };
  const saved = saveChainedWeeksAsDraftPeriods({ rotaPeriods: [], shifts: [], assignments: [] }, result, newId, '2026-08-01T00:00:00Z');

  assert.equal(saved.rotaPeriods.length, 1);
  assert.equal(saved.rotaPeriods[0].startDate, '2026-08-03');
  assert.equal(saved.rotaPeriods[0].endDate, '2026-08-09');
  assert.equal(saved.rotaPeriods[0].status, 'draft');
});

test('saveChainedWeeksAsDraftPeriods: creates a shift and assignment for every reception and therapist assignment', () => {
  const dates = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09'];
  const receptionByDay = dates.map(() => [{ shiftType: WHOLE_DAY, staffId: 'r1' }]);
  const therapistByDay = dates.map(() => [{ shiftType: THERAPIST_TYPE, staffId: 't1' }]);
  const result = { weeks: [fakeWeek('2026-08-03', dates, receptionByDay, therapistByDay)] };

  const saved = saveChainedWeeksAsDraftPeriods({ rotaPeriods: [], shifts: [], assignments: [] }, result, newId, '2026-08-01T00:00:00Z');

  assert.equal(saved.shifts.length, 14); // 7 reception + 7 therapist
  assert.equal(saved.assignments.length, 14);

  const receptionShift = saved.shifts.find((s) => s.date === '2026-08-03' && s.roleRequired === 'receptionist');
  assert.equal(receptionShift.shiftTypeId, WHOLE_DAY.id);
  assert.equal(receptionShift.periodId, saved.rotaPeriods[0].id);

  const receptionAssignment = saved.assignments.find((a) => a.shiftId === receptionShift.id);
  assert.equal(receptionAssignment.staffId, 'r1');
  assert.equal(receptionAssignment.status, 'assigned');
  assert.equal(receptionAssignment.plannedHours, 9.5);
  assert.equal(receptionAssignment.actualHours, null);
});

test('saveChainedWeeksAsDraftPeriods: an unfilled/empty day creates no shift at all - absence IS the gap', () => {
  const dates = ['2026-08-03'];
  const result = { weeks: [fakeWeek('2026-08-03', dates, [[]], [[]])] };
  const saved = saveChainedWeeksAsDraftPeriods({ rotaPeriods: [], shifts: [], assignments: [] }, result, newId, '2026-08-01T00:00:00Z');
  assert.equal(saved.shifts.length, 0);
});

test('saveChainedWeeksAsDraftPeriods: resaving the same week replaces the old period/shifts/assignments, not duplicates them', () => {
  const dates = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09'];
  const receptionByDay1 = dates.map(() => [{ shiftType: WHOLE_DAY, staffId: 'r1' }]);
  const receptionByDay2 = dates.map(() => [{ shiftType: WHOLE_DAY, staffId: 'r2' }]); // regenerated with a different person

  const first = saveChainedWeeksAsDraftPeriods(
    { rotaPeriods: [], shifts: [], assignments: [] },
    { weeks: [fakeWeek('2026-08-03', dates, receptionByDay1, [])] }, newId, '2026-08-01T00:00:00Z'
  );
  const second = saveChainedWeeksAsDraftPeriods(first, { weeks: [fakeWeek('2026-08-03', dates, receptionByDay2, [])] }, newId, '2026-08-01T00:00:00Z');

  assert.equal(second.rotaPeriods.length, 1, 'still just one period for this week, not two');
  assert.equal(second.shifts.length, 7);
  assert.equal(second.assignments.length, 7);
  assert.ok(second.assignments.every((a) => a.staffId === 'r2'), 'the old r1 assignments should be gone entirely, not left alongside the new ones');
});

test('saveChainedWeeksAsDraftPeriods: never touches a different, non-overlapping week\'s saved period', () => {
  const week1Dates = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09'];
  const week2Dates = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16'];

  const first = saveChainedWeeksAsDraftPeriods(
    { rotaPeriods: [], shifts: [], assignments: [] },
    { weeks: [fakeWeek('2026-08-03', week1Dates, week1Dates.map(() => [{ shiftType: WHOLE_DAY, staffId: 'r1' }]), [])] },
    newId, '2026-08-01T00:00:00Z'
  );
  const second = saveChainedWeeksAsDraftPeriods(
    first,
    { weeks: [fakeWeek('2026-08-10', week2Dates, week2Dates.map(() => [{ shiftType: WHOLE_DAY, staffId: 'r1' }]), [])] },
    newId, '2026-08-01T00:00:00Z'
  );

  assert.equal(second.rotaPeriods.length, 2, 'both weeks should have their own period, side by side');
});

test('saveChainedWeeksAsDraftPeriods: refuses to save (and changes nothing at all) if any week overlaps an already-closed period', () => {
  const dates = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09'];
  const existing = {
    rotaPeriods: [{ id: 'closed-1', startDate: '2026-08-03', endDate: '2026-08-09', status: 'closed', closedAt: '2026-08-10T00:00:00Z', closedBy: 'manager' }],
    shifts: [{ id: 'old-shift', periodId: 'closed-1', date: '2026-08-03', shiftTypeId: WHOLE_DAY.id, roleRequired: 'receptionist', isShadowSlot: false, shadowOfShiftId: null }],
    assignments: [{ id: 'old-assignment', shiftId: 'old-shift', staffId: 'r1', status: 'worked', plannedHours: 9.5, actualHours: 9.5, changeReason: null, changedAt: null }],
  };
  const result = { weeks: [fakeWeek('2026-08-03', dates, dates.map(() => [{ shiftType: WHOLE_DAY, staffId: 'r2' }]), [])] };

  assert.throws(() => saveChainedWeeksAsDraftPeriods(existing, result, newId, '2026-08-15T00:00:00Z'), /closed/);

  // and genuinely nothing changed - the closed period's real history survives untouched
  assert.equal(existing.rotaPeriods.length, 1);
  assert.equal(existing.shifts[0].id, 'old-shift');
  assert.equal(existing.assignments[0].staffId, 'r1');
});

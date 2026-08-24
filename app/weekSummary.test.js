import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickCurrentPeriod, periodCoverage, buildRecentWeeks } from './weekSummary.js';

function period(id, startDate, endDate) {
  return { id, startDate, endDate, status: 'draft' };
}

test('pickCurrentPeriod: picks the period whose range contains today', () => {
  const periods = [period('p1', '2026-08-03', '2026-08-09'), period('p2', '2026-08-10', '2026-08-16')];
  assert.equal(pickCurrentPeriod(periods, '2026-08-12').id, 'p2');
});

test('pickCurrentPeriod: falls back to the next upcoming period when today falls in a gap', () => {
  const periods = [period('p1', '2026-08-03', '2026-08-09'), period('p2', '2026-08-17', '2026-08-23')];
  assert.equal(pickCurrentPeriod(periods, '2026-08-12').id, 'p2');
});

test('pickCurrentPeriod: falls back to the most recent past period when nothing upcoming exists', () => {
  const periods = [period('p1', '2026-08-03', '2026-08-09'), period('p2', '2026-08-10', '2026-08-16')];
  assert.equal(pickCurrentPeriod(periods, '2026-09-01').id, 'p2');
});

test('pickCurrentPeriod: returns null when there are no periods at all', () => {
  assert.equal(pickCurrentPeriod([], '2026-08-12'), null);
});

test('periodCoverage: complete when every non-cancelled assignment has a staffId', () => {
  const p = period('p1', '2026-08-03', '2026-08-09');
  const shifts = [{ id: 's1', periodId: 'p1' }, { id: 's2', periodId: 'p1' }];
  const assignments = [{ id: 'a1', shiftId: 's1', staffId: 'staff-1', status: 'assigned' }, { id: 'a2', shiftId: 's2', staffId: 'staff-2', status: 'assigned' }];
  assert.deepEqual(periodCoverage(p, shifts, assignments), { complete: true, unfilledCount: 0 });
});

test('periodCoverage: counts assignments with a null staffId as unfilled', () => {
  const p = period('p1', '2026-08-03', '2026-08-09');
  const shifts = [{ id: 's1', periodId: 'p1' }, { id: 's2', periodId: 'p1' }];
  const assignments = [{ id: 'a1', shiftId: 's1', staffId: null, status: 'assigned' }, { id: 'a2', shiftId: 's2', staffId: 'staff-2', status: 'assigned' }];
  assert.deepEqual(periodCoverage(p, shifts, assignments), { complete: false, unfilledCount: 1 });
});

test('periodCoverage: ignores cancelled assignments even without a staffId', () => {
  const p = period('p1', '2026-08-03', '2026-08-09');
  const shifts = [{ id: 's1', periodId: 'p1' }];
  const assignments = [{ id: 'a1', shiftId: 's1', staffId: null, status: 'cancelled' }];
  assert.deepEqual(periodCoverage(p, shifts, assignments), { complete: true, unfilledCount: 0 });
});

test('periodCoverage: a null period is treated as complete (nothing to warn about)', () => {
  assert.deepEqual(periodCoverage(null, [], []), { complete: true, unfilledCount: 0 });
});

test('buildRecentWeeks: only includes periods starting before the target, oldest first', () => {
  const target = period('p3', '2026-08-17', '2026-08-23');
  const rotaPeriods = [period('p2', '2026-08-10', '2026-08-16'), period('p1', '2026-08-03', '2026-08-09'), target];
  const shifts = [{ id: 's1', periodId: 'p1' }, { id: 's2', periodId: 'p2' }];
  const assignments = [
    { id: 'a1', shiftId: 's1', staffId: 'staff-1', status: 'assigned' },
    { id: 'a2', shiftId: 's2', staffId: 'staff-1', status: 'assigned' },
  ];
  const result = buildRecentWeeks(rotaPeriods, shifts, assignments, target);
  assert.deepEqual(result.map((w) => w.weekStart), ['2026-08-03', '2026-08-10']);
});

test('buildRecentWeeks: staffIdsWithShifts excludes cancelled and unfilled assignments, dedupes multi-shift staff', () => {
  const target = period('p2', '2026-08-10', '2026-08-16');
  const rotaPeriods = [period('p1', '2026-08-03', '2026-08-09'), target];
  const shifts = [{ id: 's1', periodId: 'p1' }, { id: 's2', periodId: 'p1' }, { id: 's3', periodId: 'p1' }];
  const assignments = [
    { id: 'a1', shiftId: 's1', staffId: 'staff-1', status: 'assigned' },
    { id: 'a2', shiftId: 's2', staffId: 'staff-1', status: 'assigned' },
    { id: 'a3', shiftId: 's3', staffId: 'staff-2', status: 'cancelled' },
  ];
  const result = buildRecentWeeks(rotaPeriods, shifts, assignments, target);
  assert.deepEqual(result[0].staffIdsWithShifts, ['staff-1']);
});

test('buildRecentWeeks: returns an empty array when there is no target period', () => {
  assert.deepEqual(buildRecentWeeks([period('p1', '2026-08-03', '2026-08-09')], [], [], null), []);
});

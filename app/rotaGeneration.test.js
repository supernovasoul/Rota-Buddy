import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekStartsForMonth, summarizeGeneration } from './rotaGeneration.js';

test('weekStartsForMonth: a month starting on a Monday needs no earlier Monday', () => {
  // August 2026 starts on a Saturday, so pick a month starting on a Monday instead: March 2027 starts Monday
  const starts = weekStartsForMonth(2027, 3);
  assert.equal(starts[0], '2027-03-01');
});

test('weekStartsForMonth: a month NOT starting on a Monday reaches back to the Monday on or before the 1st', () => {
  // August 1 2026 is a Saturday, so the containing week's Monday (July 27) is the RIGHT starting point -
  // never August 3, which would skip Aug 1-2 entirely out of the generated batch
  const starts = weekStartsForMonth(2026, 8);
  assert.equal(starts[0], '2026-07-27');
});

test('weekStartsForMonth: extends to the Monday of the week containing the LAST day of the month too', () => {
  const starts = weekStartsForMonth(2026, 8); // Aug 31 2026 is a Monday
  assert.equal(starts[starts.length - 1], '2026-08-31');
});

test('weekStartsForMonth: every entry is exactly 7 days after the previous one', () => {
  const starts = weekStartsForMonth(2026, 8);
  for (let i = 1; i < starts.length; i++) {
    const prev = new Date(`${starts[i - 1]}T00:00:00Z`);
    const cur = new Date(`${starts[i]}T00:00:00Z`);
    assert.equal((cur - prev) / (1000 * 60 * 60 * 24), 7);
  }
});

test('weekStartsForMonth: a typical month spans 4-6 weeks, never fewer or more', () => {
  for (let month = 1; month <= 12; month++) {
    const starts = weekStartsForMonth(2026, month);
    assert.ok(starts.length >= 4 && starts.length <= 6, `month ${month} had ${starts.length} weeks`);
  }
});

function fakeWeek({ receptionDays, therapistDays }) {
  return { reception: { days: receptionDays }, therapist: { days: therapistDays } };
}

test('summarizeGeneration: counts every assignment across reception and therapist, across all weeks', () => {
  const weeks = [
    fakeWeek({
      receptionDays: [{ date: '2026-08-03', unfilled: false, assignment: [{ staffId: 1 }] }],
      therapistDays: [{ date: '2026-08-03', assignment: [{ staffId: 2 }, { staffId: 3 }] }],
    }),
  ];
  const summary = summarizeGeneration(weeks, [], () => 0);
  assert.equal(summary.shiftsAllocated, 3);
});

test('summarizeGeneration: flags coverage as incomplete when any reception day is unfilled, and counts them', () => {
  const weeks = [
    fakeWeek({
      receptionDays: [
        { date: '2026-08-03', unfilled: true, assignment: [] },
        { date: '2026-08-04', unfilled: false, assignment: [{ staffId: 1 }] },
      ],
      therapistDays: [],
    }),
  ];
  const summary = summarizeGeneration(weeks, [], () => 0);
  assert.equal(summary.coverageComplete, false);
  assert.equal(summary.unfilledDays, 1);
  assert.ok(summary.line.includes('1 day'));
});

test('summarizeGeneration: computes the widest fairness deviation across staff, using each role\'s own dimensions', () => {
  const weeks = [fakeWeek({ receptionDays: [], therapistDays: [] })];
  const staff = [{ id: 1, role: 'receptionist' }, { id: 2, role: 'therapist' }];
  const finalBalance = (staffId, dim) => (staffId === 1 && dim === 'REC_WEEKEND' ? -7 : 0.5);
  const summary = summarizeGeneration(weeks, staff, finalBalance);
  assert.equal(summary.maxAbsDeviation, 7);
});

test('summarizeGeneration: the easter egg flourish only appears when coverage is complete AND fairness is tight', () => {
  const weeks = [fakeWeek({ receptionDays: [{ date: '2026-08-03', unfilled: false, assignment: [] }], therapistDays: [] })];
  const staff = [{ id: 1, role: 'receptionist' }];

  const tight = summarizeGeneration(weeks, staff, () => 0.2, 1);
  assert.ok(tight.line.includes('✨'));

  const loose = summarizeGeneration(weeks, staff, () => 20, 1);
  assert.ok(!loose.line.includes('✨'));
});

test('summarizeGeneration: never shows the flourish if coverage is incomplete, no matter how balanced fairness is', () => {
  const weeks = [fakeWeek({ receptionDays: [{ date: '2026-08-03', unfilled: true, assignment: [] }], therapistDays: [] })];
  const staff = [{ id: 1, role: 'receptionist' }];
  const summary = summarizeGeneration(weeks, staff, () => 0, 1);
  assert.ok(!summary.line.includes('✨'));
});

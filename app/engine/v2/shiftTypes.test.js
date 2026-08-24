import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shiftTypeSpanHours, shiftTypePaidHours, resolveOpeningHours, resolveShiftTypeSet } from './shiftTypes.js';

test('shiftTypeSpanHours: wall-clock span, ignores breaks', () => {
  assert.equal(shiftTypeSpanHours({ start: '10:30', end: '21:00', breakMinutes: 60 }), 10.5);
  assert.equal(shiftTypeSpanHours({ start: '11:00', end: '20:00' }), 9);
});

test('shiftTypePaidHours: subtracts this shift type\'s own breakMinutes', () => {
  assert.equal(shiftTypePaidHours({ start: '10:30', end: '21:00', breakMinutes: 60 }), 9.5);
  assert.equal(shiftTypePaidHours({ start: '11:00', end: '17:00', breakMinutes: 30 }), 5.5);
});

test('shiftTypePaidHours: no breakMinutes field defaults to zero break, not a hidden assumption of one', () => {
  assert.equal(shiftTypePaidHours({ start: '09:00', end: '15:00' }), 6);
});

test('shiftTypePaidHours: varies freely across differently-configured shift types (weekday/weekend/role are just different entries)', () => {
  const weekdayReception = { name: 'Whole day', start: '10:30', end: '21:00', breakMinutes: 60 };
  const weekendReception = { name: 'Weekend full day', start: '08:30', end: '18:00', breakMinutes: 60 };
  const weekdayTherapist = { name: 'Weekday', start: '11:00', end: '20:00', breakMinutes: 60 };
  const weekendTherapist = { name: 'Weekend', start: '09:00', end: '17:00', breakMinutes: 30 };
  assert.equal(shiftTypePaidHours(weekdayReception), 9.5);
  assert.equal(shiftTypePaidHours(weekendReception), 8.5);
  assert.equal(shiftTypePaidHours(weekdayTherapist), 8);
  assert.equal(shiftTypePaidHours(weekendTherapist), 7.5);
});

test('resolveOpeningHours: defaults to the weekday span on a weekday', () => {
  const openingHours = {
    defaultWeekday: { start: '10:30', end: '21:00' },
    defaultWeekend: { start: '08:30', end: '18:00' },
    overrides: [],
  };
  assert.deepEqual(resolveOpeningHours(openingHours, '2026-08-03', false), { start: '10:30', end: '21:00', closed: false });
});

test('resolveOpeningHours: defaults to the weekend span on a weekend', () => {
  const openingHours = {
    defaultWeekday: { start: '10:30', end: '21:00' },
    defaultWeekend: { start: '08:30', end: '18:00' },
    overrides: [],
  };
  assert.deepEqual(resolveOpeningHours(openingHours, '2026-08-08', true), { start: '08:30', end: '18:00', closed: false });
});

test('resolveOpeningHours: a date-specific override wins over the default (e.g. reduced bank-holiday hours)', () => {
  const openingHours = {
    defaultWeekday: { start: '10:30', end: '21:00' },
    defaultWeekend: { start: '08:30', end: '18:00' },
    overrides: [{ date: '2026-12-26', start: '11:00', end: '16:00', closed: false, isSpecialDay: true, note: 'Boxing Day' }],
  };
  assert.deepEqual(resolveOpeningHours(openingHours, '2026-12-26', false), { start: '11:00', end: '16:00', closed: false });
});

test('resolveOpeningHours: a closed override is reported as closed', () => {
  const openingHours = {
    defaultWeekday: { start: '10:30', end: '21:00' },
    defaultWeekend: { start: '08:30', end: '18:00' },
    overrides: [{ date: '2026-12-25', start: '00:00', end: '00:00', closed: true, note: 'Christmas Day' }],
  };
  assert.equal(resolveOpeningHours(openingHours, '2026-12-25', false).closed, true);
});

test('resolveShiftTypeSet: picks the set whose effective range includes the date', () => {
  const sets = [
    { id: 'a', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30', receptionShiftTypes: [], therapistShiftTypes: [] },
    { id: 'b', effectiveFrom: '2026-07-01', effectiveTo: null, receptionShiftTypes: [], therapistShiftTypes: [] },
  ];
  assert.equal(resolveShiftTypeSet(sets, '2026-03-15').id, 'a');
  assert.equal(resolveShiftTypeSet(sets, '2026-08-01').id, 'b');
});

test('resolveShiftTypeSet: when multiple candidates match, the latest effectiveFrom wins', () => {
  const sets = [
    { id: 'old', effectiveFrom: '2026-01-01', effectiveTo: null, receptionShiftTypes: [], therapistShiftTypes: [] },
    { id: 'new', effectiveFrom: '2026-06-01', effectiveTo: null, receptionShiftTypes: [], therapistShiftTypes: [] },
  ];
  assert.equal(resolveShiftTypeSet(sets, '2026-08-01').id, 'new');
});

test('resolveShiftTypeSet: no matching set returns null rather than guessing', () => {
  const sets = [{ id: 'a', effectiveFrom: '2027-01-01', effectiveTo: null, receptionShiftTypes: [], therapistShiftTypes: [] }];
  assert.equal(resolveShiftTypeSet(sets, '2026-08-01'), null);
});

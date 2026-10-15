import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateOpeningHoursDefaults, newOverrideDraft, validateOverrideDraft, upsertOverride, removeOverride,
  newShiftTypeDraft, validateShiftTypeDraft, upsertShiftType, removeShiftType, validateWeeklyCapSetting,
} from './scheduleSettings.js';

test('validateOpeningHoursDefaults: valid weekday and weekend spans produce no errors', () => {
  const errors = validateOpeningHoursDefaults({ start: '10:30', end: '21:00' }, { start: '08:30', end: '18:00' });
  assert.deepEqual(errors, []);
});

test('validateOpeningHoursDefaults: a start at or after end is invalid', () => {
  const errors = validateOpeningHoursDefaults({ start: '21:00', end: '10:30' }, { start: '08:30', end: '18:00' });
  assert.ok(errors.some((e) => e.includes('Weekday')));
});

test('validateOpeningHoursDefaults: reports both spans independently when both are wrong', () => {
  const errors = validateOpeningHoursDefaults({ start: 'bad', end: '21:00' }, { start: 'also-bad', end: '18:00' });
  assert.equal(errors.length, 2);
});

test('newOverrideDraft: starts blank and not closed', () => {
  const draft = newOverrideDraft();
  assert.equal(draft.date, '');
  assert.equal(draft.closed, false);
});

test('validateOverrideDraft: a date is always required, even when closed', () => {
  const errors = validateOverrideDraft({ date: '', closed: true });
  assert.ok(errors.some((e) => e.includes('date')));
});

test('validateOverrideDraft: a closed override needs no start/end times', () => {
  const errors = validateOverrideDraft({ date: '2026-12-25', closed: true, start: '', end: '' });
  assert.deepEqual(errors, []);
});

test('validateOverrideDraft: a non-closed override needs valid, ordered start/end times', () => {
  const errors = validateOverrideDraft({ date: '2026-12-24', closed: false, start: '17:00', end: '11:00' });
  assert.ok(errors.some((e) => e.includes('start must be before end')));
});

test('upsertOverride: adding a new date appends it, sorted by date', () => {
  const overrides = [{ date: '2026-08-06', start: '', end: '', closed: true, note: '' }];
  const result = upsertOverride(overrides, { date: '2026-01-01', start: '11:00', end: '16:00', closed: false, note: 'New Year short day' });
  assert.deepEqual(result.map((o) => o.date), ['2026-01-01', '2026-08-06']);
});

test('upsertOverride: saving for a date that already has an override replaces it rather than duplicating', () => {
  const overrides = [{ date: '2026-08-06', start: '', end: '', closed: true, note: 'old note' }];
  const result = upsertOverride(overrides, { date: '2026-08-06', start: '11:00', end: '16:00', closed: false, note: 'reopened after all' });
  assert.equal(result.length, 1);
  assert.equal(result[0].note, 'reopened after all');
});

test('removeOverride: removes only the matching date', () => {
  const overrides = [{ date: '2026-08-06', closed: true }, { date: '2026-12-25', closed: true }];
  const result = removeOverride(overrides, '2026-08-06');
  assert.deepEqual(result.map((o) => o.date), ['2026-12-25']);
});

test('newShiftTypeDraft: starts with a null id (so the caller knows to create rather than update)', () => {
  assert.equal(newShiftTypeDraft().id, null);
});

test('validateShiftTypeDraft: a valid draft has no errors', () => {
  const errors = validateShiftTypeDraft({ name: 'Whole day', start: '10:30', end: '21:00', breakMinutes: 60 });
  assert.deepEqual(errors, []);
});

test('validateShiftTypeDraft: requires a name', () => {
  const errors = validateShiftTypeDraft({ name: '', start: '10:30', end: '21:00', breakMinutes: 0 });
  assert.ok(errors.some((e) => e.includes('name')));
});

test('validateShiftTypeDraft: start must be before end', () => {
  const errors = validateShiftTypeDraft({ name: 'Late', start: '21:00', end: '15:15', breakMinutes: 30 });
  assert.ok(errors.some((e) => e.includes('before end')));
});

test('validateShiftTypeDraft: negative break minutes is invalid', () => {
  const errors = validateShiftTypeDraft({ name: 'Morning', start: '10:30', end: '15:30', breakMinutes: -10 });
  assert.ok(errors.some((e) => e.includes('Break minutes')));
});

test('validateShiftTypeDraft: a reception shift type needs a recognised pattern slot', () => {
  const errors = validateShiftTypeDraft({ name: 'Morning', start: '10:30', end: '15:30', breakMinutes: 0, slot: '' }, 'receptionist');
  assert.ok(errors.some((e) => e.includes('slot')));
});

test('validateShiftTypeDraft: a reception shift type with a valid slot has no slot-related error', () => {
  const errors = validateShiftTypeDraft({ name: 'Morning', start: '10:30', end: '15:30', breakMinutes: 0, slot: 'early' }, 'receptionist');
  assert.equal(errors.some((e) => e.includes('slot')), false);
});

test('validateShiftTypeDraft: a therapist shift type needs no slot at all', () => {
  const errors = validateShiftTypeDraft({ name: 'Weekday', start: '11:00', end: '20:00', breakMinutes: 60 }, 'therapist');
  assert.equal(errors.length, 0);
});

test('upsertShiftType: a draft with no id is added as a new entry with a fresh id', () => {
  const types = [{ id: 'a', name: 'Morning', start: '10:30', end: '15:30', breakMinutes: 0 }];
  const result = upsertShiftType(types, { id: null, name: 'Late', start: '15:15', end: '21:00', breakMinutes: 30 }, () => 'new-id');
  assert.equal(result.length, 2);
  assert.equal(result[1].id, 'new-id');
});

test('upsertShiftType: a draft with an existing id updates that entry in place, leaving others untouched', () => {
  const types = [
    { id: 'a', name: 'Morning', start: '10:30', end: '15:30', breakMinutes: 0 },
    { id: 'b', name: 'Late', start: '15:15', end: '21:00', breakMinutes: 30 },
  ];
  const result = upsertShiftType(types, { id: 'a', name: 'Morning (updated)', start: '10:00', end: '15:00', breakMinutes: 0 }, () => 'unused');
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'Morning (updated)');
  assert.equal(result[1].name, 'Late');
});

test('removeShiftType: removes only the matching id', () => {
  const types = [{ id: 'a' }, { id: 'b' }];
  const result = removeShiftType(types, 'a');
  assert.deepEqual(result.map((t) => t.id), ['b']);
});

test('validateWeeklyCapSetting: a positive number is valid', () => {
  assert.deepEqual(validateWeeklyCapSetting(39), []);
});

test('validateWeeklyCapSetting: zero or negative is invalid', () => {
  assert.ok(validateWeeklyCapSetting(0).length > 0);
  assert.ok(validateWeeklyCapSetting(-5).length > 0);
});

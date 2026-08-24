import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newStaffDraft, validateStaffDraft, isArchived, archiveStaff, reinstateStaff, deleteStaffGdpr } from './staff.js';

test('newStaffDraft: a therapist draft defaults to a full contracted fraction; a receptionist draft has none', () => {
  assert.equal(newStaffDraft('therapist').proportionalFraction, 1.0);
  assert.equal(newStaffDraft('receptionist').proportionalFraction, null);
});

test('newStaffDraft: priority weight defaults to neutral with no reason required', () => {
  const draft = newStaffDraft('receptionist');
  assert.equal(draft.priorityWeight, 1.0);
  assert.equal(draft.priorityWeightReason, null);
  assert.deepEqual(validateStaffDraft({ ...draft, name: 'Amira', startDate: '2026-01-01' }), []);
});

test('validateStaffDraft: reports every problem at once, not just the first', () => {
  const errors = validateStaffDraft({ name: '', role: 'receptionist', employmentType: 'flex', startDate: '' });
  assert.ok(errors.length >= 2);
});

test('validateStaffDraft: a therapist with no contracted fraction is invalid', () => {
  const draft = { name: 'Dev', role: 'therapist', employmentType: 'flex', startDate: '2026-01-01', proportionalFraction: null };
  const errors = validateStaffDraft(draft);
  assert.ok(errors.some((e) => e.includes('Contracted fraction')));
});

test('validateStaffDraft: a receptionist needs no contracted fraction at all', () => {
  const draft = { name: 'Amira', role: 'receptionist', employmentType: 'flex', startDate: '2026-01-01', proportionalFraction: null };
  assert.deepEqual(validateStaffDraft(draft), []);
});

test('validateStaffDraft: a non-neutral priority weight requires a reason', () => {
  const draft = { name: 'Dev', role: 'therapist', employmentType: 'flex', startDate: '2026-01-01', proportionalFraction: 1.0, priorityWeight: 1.5, priorityWeightReason: '' };
  const errors = validateStaffDraft(draft);
  assert.ok(errors.some((e) => e.includes('reason')));
});

test('validateStaffDraft: a non-neutral priority weight WITH a reason is valid', () => {
  const draft = { name: 'Dev', role: 'therapist', employmentType: 'flex', startDate: '2026-01-01', proportionalFraction: 1.0, priorityWeight: 1.5, priorityWeightReason: 'Senior therapist, higher client demand' };
  assert.deepEqual(validateStaffDraft(draft), []);
});

test('validateStaffDraft: no cap override set is valid (the common case)', () => {
  const draft = { name: 'Amira', role: 'receptionist', employmentType: 'flex', startDate: '2026-01-01', weeklyHourCapOverride: null };
  assert.deepEqual(validateStaffDraft(draft), []);
});

test('validateStaffDraft: an approved cap override needs a positive hour figure', () => {
  const draft = { name: 'Amira', role: 'receptionist', employmentType: 'flex', startDate: '2026-01-01', weeklyHourCapOverride: { approved: true, capHours: 0, note: 'Opted in for more hours' } };
  const errors = validateStaffDraft(draft);
  assert.ok(errors.some((e) => e.includes('positive number of hours')));
});

test('validateStaffDraft: an approved cap override needs a reason', () => {
  const draft = { name: 'Amira', role: 'receptionist', employmentType: 'flex', startDate: '2026-01-01', weeklyHourCapOverride: { approved: true, capHours: 45, note: '' } };
  const errors = validateStaffDraft(draft);
  assert.ok(errors.some((e) => e.includes('reason')));
});

test('validateStaffDraft: a complete, well-formed cap override is valid', () => {
  const draft = { name: 'Amira', role: 'receptionist', employmentType: 'flex', startDate: '2026-01-01', weeklyHourCapOverride: { approved: true, capHours: 45, note: 'Opted in for more hours, approved by manager' } };
  assert.deepEqual(validateStaffDraft(draft), []);
});

test('validateStaffDraft: an end date before the start date is invalid', () => {
  const draft = { name: 'Amira', role: 'receptionist', employmentType: 'flex', startDate: '2026-06-01', endDate: '2026-01-01' };
  const errors = validateStaffDraft(draft);
  assert.ok(errors.some((e) => e.includes('End date')));
});

test('validateStaffDraft: a negative wage rate is invalid', () => {
  const draft = { name: 'Amira', role: 'receptionist', employmentType: 'flex', startDate: '2026-01-01', hourlyWageRate: -5 };
  const errors = validateStaffDraft(draft);
  assert.ok(errors.some((e) => e.includes('Wage rate')));
});

test('isArchived: a staff member with no end date is not archived', () => {
  assert.equal(isArchived({ endDate: null }, '2026-08-03'), false);
});

test('isArchived: true once today reaches or passes their end date, not before', () => {
  assert.equal(isArchived({ endDate: '2026-08-03' }, '2026-08-02'), false);
  assert.equal(isArchived({ endDate: '2026-08-03' }, '2026-08-03'), true);
  assert.equal(isArchived({ endDate: '2026-08-03' }, '2026-08-04'), true);
});

test('archiveStaff: sets the end date on the matching person only, leaving everyone else untouched', () => {
  const staff = [{ id: 1, endDate: null }, { id: 2, endDate: null }];
  const updated = archiveStaff(staff, 1, '2026-08-03');
  assert.equal(updated.find((s) => s.id === 1).endDate, '2026-08-03');
  assert.equal(updated.find((s) => s.id === 2).endDate, null);
});

test('reinstateStaff: clears the end date, undoing an archive', () => {
  const staff = [{ id: 1, endDate: '2026-08-03' }];
  const updated = reinstateStaff(staff, 1);
  assert.equal(updated[0].endDate, null);
});

test('deleteStaffGdpr: removes the record entirely, not just marking it', () => {
  const staff = [{ id: 1 }, { id: 2 }];
  const updated = deleteStaffGdpr(staff, 1);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, 2);
});

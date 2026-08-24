import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newSwapDraft, validateSwapDraft, swapAssignmentStaff, dismissAssignmentWarnings } from './manualEdit.js';

let idCounter = 0;
function newId() { return `id-${idCounter++}`; }

const STAFF = [
  { id: 'r1', name: 'Ada', role: 'receptionist' },
  { id: 'r2', name: 'Bea', role: 'receptionist' },
  { id: 't1', name: 'Cate', role: 'therapist' },
];
const SHIFT = { id: 'sh1', periodId: 'p1', date: '2026-08-03', shiftTypeId: 'st1', roleRequired: 'receptionist', isShadowSlot: false, shadowOfShiftId: null };
const OTHER_SHIFT = { id: 'sh2', periodId: 'p1', date: '2026-08-04', shiftTypeId: 'st1', roleRequired: 'receptionist', isShadowSlot: false, shadowOfShiftId: null };
const ASSIGNMENT = { id: 'a1', shiftId: 'sh1', staffId: 'r1', status: 'assigned', plannedHours: 6, actualHours: null, changeReason: null, changedAt: null };
const OTHER_ASSIGNMENT = { id: 'a2', shiftId: 'sh2', staffId: 'r2', status: 'assigned', plannedHours: 6, actualHours: null, changeReason: null, changedAt: null };

function context(overrides = {}) {
  return { assignments: [ASSIGNMENT, OTHER_ASSIGNMENT], shifts: [SHIFT, OTHER_SHIFT], staff: STAFF, ...overrides };
}

test('newSwapDraft: starts from the assignment\'s current staff', () => {
  assert.deepEqual(newSwapDraft(ASSIGNMENT), { assignmentId: 'a1', staffId: 'r1' });
});

test('validateSwapDraft: rejects a role mismatch', () => {
  const errors = validateSwapDraft({ assignmentId: 'a1', staffId: 't1' }, context());
  assert.ok(errors.some((e) => /receptionist/.test(e) && /therapist/.test(e)));
});

test('validateSwapDraft: rejects swapping in the same person already on the shift', () => {
  const errors = validateSwapDraft({ assignmentId: 'a1', staffId: 'r1' }, context());
  assert.ok(errors.some((e) => /already on this shift/.test(e)));
});

test('validateSwapDraft: rejects a missing staffId selection', () => {
  const errors = validateSwapDraft({ assignmentId: 'a1', staffId: '' }, context());
  assert.ok(errors.some((e) => /Choose who to swap in/.test(e)));
});

test('validateSwapDraft: rejects an assignment that no longer exists', () => {
  const errors = validateSwapDraft({ assignmentId: 'gone', staffId: 'r2' }, context());
  assert.ok(errors.some((e) => /no longer exists/.test(e)));
});

test('validateSwapDraft: rejects a staff member that no longer exists', () => {
  const errors = validateSwapDraft({ assignmentId: 'a1', staffId: 'gone' }, context());
  assert.ok(errors.some((e) => /staff member no longer exists/.test(e)));
});

test('validateSwapDraft: passes for a valid same-role, different-person swap', () => {
  const errors = validateSwapDraft({ assignmentId: 'a1', staffId: 'r2' }, context());
  assert.deepEqual(errors, []);
});

test('swapAssignmentStaff: updates only the target assignment\'s staffId, leaving others untouched', () => {
  const result = swapAssignmentStaff(
    { assignments: [ASSIGNMENT, OTHER_ASSIGNMENT], auditLog: [] },
    { assignmentId: 'a1', staffId: 'r2' }, newId, '2026-07-25T10:00:00Z'
  );
  assert.equal(result.assignments.find((a) => a.id === 'a1').staffId, 'r2');
  assert.equal(result.assignments.find((a) => a.id === 'a2'), OTHER_ASSIGNMENT, 'the other assignment must be the exact same object, untouched');
});

test('swapAssignmentStaff: does not mutate the input assignments array', () => {
  const assignments = [ASSIGNMENT, OTHER_ASSIGNMENT];
  swapAssignmentStaff({ assignments, auditLog: [] }, { assignmentId: 'a1', staffId: 'r2' }, newId, '2026-07-25T10:00:00Z');
  assert.equal(assignments.find((a) => a.id === 'a1').staffId, 'r1', 'original array/object must be unchanged');
});

test('swapAssignmentStaff: clears any dismissed warnings, since they belonged to the previous person\'s situation', () => {
  const withDismissed = { ...ASSIGNMENT, dismissedWarnings: ['Leaves only 1.0h rest around this shift (11h minimum).'] };
  const result = swapAssignmentStaff(
    { assignments: [withDismissed, OTHER_ASSIGNMENT], auditLog: [] },
    { assignmentId: 'a1', staffId: 'r2' }, newId, '2026-07-25T10:00:00Z'
  );
  assert.deepEqual(result.assignments.find((a) => a.id === 'a1').dismissedWarnings, []);
});

test('swapAssignmentStaff: records a manual_override audit entry with correct before/after', () => {
  const result = swapAssignmentStaff(
    { assignments: [ASSIGNMENT, OTHER_ASSIGNMENT], auditLog: [] },
    { assignmentId: 'a1', staffId: 'r2' }, newId, '2026-07-25T10:00:00Z'
  );
  assert.equal(result.auditLog.length, 1);
  const entry = result.auditLog[0];
  assert.equal(entry.type, 'manual_override');
  assert.equal(entry.staffId, 'r2');
  assert.equal(entry.shiftId, 'sh1');
  assert.deepEqual(entry.before, { staffId: 'r1' });
  assert.deepEqual(entry.after, { staffId: 'r2' });
});

test('dismissAssignmentWarnings: adds the given warnings to the assignment\'s dismissed list', () => {
  const result = dismissAssignmentWarnings(
    { assignments: [ASSIGNMENT, OTHER_ASSIGNMENT], auditLog: [] },
    'a1', ['Ada isn\'t marked available on 2026-08-03.'], newId, '2026-07-25T10:00:00Z'
  );
  assert.deepEqual(result.assignments.find((a) => a.id === 'a1').dismissedWarnings, ['Ada isn\'t marked available on 2026-08-03.']);
});

test('dismissAssignmentWarnings: accumulates onto existing dismissals without duplicating', () => {
  const withExisting = { ...ASSIGNMENT, dismissedWarnings: ['already checked this one'] };
  const result = dismissAssignmentWarnings(
    { assignments: [withExisting, OTHER_ASSIGNMENT], auditLog: [] },
    'a1', ['already checked this one', 'a new one'], newId, '2026-07-25T10:00:00Z'
  );
  assert.deepEqual(result.assignments.find((a) => a.id === 'a1').dismissedWarnings, ['already checked this one', 'a new one']);
});

test('dismissAssignmentWarnings: leaves other assignments untouched', () => {
  const result = dismissAssignmentWarnings(
    { assignments: [ASSIGNMENT, OTHER_ASSIGNMENT], auditLog: [] },
    'a1', ['some warning'], newId, '2026-07-25T10:00:00Z'
  );
  assert.equal(result.assignments.find((a) => a.id === 'a2'), OTHER_ASSIGNMENT);
});

test('dismissAssignmentWarnings: records a manual_override audit entry naming what was checked', () => {
  const result = dismissAssignmentWarnings(
    { assignments: [ASSIGNMENT, OTHER_ASSIGNMENT], auditLog: [] },
    'a1', ['Ada isn\'t marked available on 2026-08-03.'], newId, '2026-07-25T10:00:00Z'
  );
  assert.equal(result.auditLog.length, 1);
  const entry = result.auditLog[0];
  assert.equal(entry.type, 'manual_override');
  assert.equal(entry.staffId, 'r1');
  assert.equal(entry.shiftId, 'sh1');
  assert.match(entry.note, /Marked as checked/);
});

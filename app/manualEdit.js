// Pure logic for Phase 7 manual editing of a saved rota period - no DOM
// here, same convention as rotaPeriods.js/rotaClose.js: every mutator
// takes only the state slices it needs plus injected newId/nowIso, and
// returns new slices rather than mutating in place. This increment
// covers swap only; cancel/reduce/restore, shadow, and shape-swap are
// added here in later increments (see the Phase 7 plan).

import { appendAuditLog } from './auditLog.js';

export function newSwapDraft(assignment) {
  return { assignmentId: assignment.id, staffId: assignment.staffId };
}

// Deliberately checked all at once (not fail-fast), matching
// validateStaffDraft's convention - a manager sees every problem in one
// pass, not one at a time.
export function validateSwapDraft(draft, { assignments, shifts, staff }) {
  const errors = [];

  const assignment = assignments.find((a) => a.id === draft.assignmentId);
  if (!assignment) {
    errors.push('That assignment no longer exists.');
    return errors;
  }

  if (!draft.staffId) {
    errors.push('Choose who to swap in.');
    return errors;
  }

  const newStaffMember = staff.find((s) => s.id === draft.staffId);
  if (!newStaffMember) {
    errors.push('That staff member no longer exists.');
    return errors;
  }

  const shift = shifts.find((s) => s.id === assignment.shiftId);
  if (shift && newStaffMember.role !== shift.roleRequired) {
    errors.push(`This shift needs a ${shift.roleRequired}, but ${newStaffMember.name} is a ${newStaffMember.role}.`);
  }

  if (draft.staffId === assignment.staffId) {
    errors.push('Choose someone different to swap in - they\'re already on this shift.');
  }

  return errors;
}

export function swapAssignmentStaff({ assignments, auditLog }, draft, newId, nowIso) {
  const assignment = assignments.find((a) => a.id === draft.assignmentId);
  const before = { staffId: assignment.staffId };
  const after = { staffId: draft.staffId };

  // Dismissals were a manager's judgement call about the PREVIOUS person's
  // situation on this shift - some warning text (the rest-gap message)
  // doesn't include a name, so without this reset a dismissal could
  // silently suppress a genuinely new warning for whoever gets swapped in
  // next, if their numbers happen to produce the same wording.
  const updatedAssignments = assignments.map((a) => (
    a.id === draft.assignmentId ? { ...a, staffId: draft.staffId, dismissedWarnings: [] } : a
  ));

  const updatedAuditLog = appendAuditLog(auditLog, newId, nowIso, {
    type: 'manual_override',
    staffId: draft.staffId,
    shiftId: assignment.shiftId,
    before,
    after,
    note: 'Swapped staff on this shift',
  });

  return { assignments: updatedAssignments, auditLog: updatedAuditLog };
}

// Marks specific advisory warning strings as checked for this assignment,
// so they stop counting toward "needs a second look" without touching the
// underlying data that caused them (see editWarnings.js's
// undismissedWarnings - a warning that changes to something genuinely new
// still surfaces, only the exact thing already checked is suppressed).
export function dismissAssignmentWarnings({ assignments, auditLog }, assignmentId, warnings, newId, nowIso) {
  const assignment = assignments.find((a) => a.id === assignmentId);

  const updatedAssignments = assignments.map((a) => (
    a.id === assignmentId
      ? { ...a, dismissedWarnings: [...new Set([...(a.dismissedWarnings ?? []), ...warnings])] }
      : a
  ));

  const updatedAuditLog = appendAuditLog(auditLog, newId, nowIso, {
    type: 'manual_override',
    staffId: assignment.staffId,
    shiftId: assignment.shiftId,
    before: null,
    after: null,
    note: `Marked as checked: ${warnings.join(' ')}`,
  });

  return { assignments: updatedAssignments, auditLog: updatedAuditLog };
}

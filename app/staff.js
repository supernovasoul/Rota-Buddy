// Pure staff-record logic for the Settings UI (Phase 4) - no DOM here,
// so it's unit-testable the same way the engine is. See app/data-model.md
// for the staff[] shape this operates on.

export function newStaffDraft(role) {
  return {
    id: null, // filled in by the caller (state.js's newId()) only once the form is actually saved
    name: '',
    role,
    startDate: '',
    endDate: null,
    employmentType: 'flex',
    proportionalFraction: role === 'therapist' ? 1.0 : null,
    weeklyHourCapOverride: null,
    priorityWeight: 1.0,
    priorityWeightReason: null,
    hourlyWageRate: null,
    restWeekPolicyOverride: null,
  };
}

// Returns a list of plain-English error strings - empty means valid.
// Deliberately checked all at once (not fail-fast) so a manager filling
// in the form sees every problem in one pass, not one at a time.
export function validateStaffDraft(draft) {
  const errors = [];

  if (!draft.name || !draft.name.trim()) errors.push('Name is required.');
  if (draft.role !== 'receptionist' && draft.role !== 'therapist') errors.push('Role must be receptionist or therapist.');
  if (draft.employmentType !== 'fixed_pattern' && draft.employmentType !== 'flex') errors.push('Employment type must be fixed pattern or flex.');
  if (!draft.startDate) errors.push('Start date is required.');
  if (draft.endDate && draft.startDate && draft.endDate < draft.startDate) errors.push('End date cannot be before the start date.');

  if (draft.role === 'therapist') {
    if (draft.proportionalFraction === null || draft.proportionalFraction === undefined || Number(draft.proportionalFraction) <= 0) {
      errors.push('Contracted fraction is required for therapists and must be greater than zero.');
    }
  }

  const weight = draft.priorityWeight ?? 1.0;
  if (weight !== 1.0 && (!draft.priorityWeightReason || !draft.priorityWeightReason.trim())) {
    errors.push('A reason is required whenever priority weight is not neutral (1.0) - see the priority weighting policy.');
  }

  if (draft.weeklyHourCapOverride) {
    const { capHours, note } = draft.weeklyHourCapOverride;
    if (capHours === null || capHours === undefined || Number(capHours) <= 0) {
      errors.push('The approved personal cap must be a positive number of hours.');
    }
    if (!note || !note.trim()) {
      errors.push('A reason is required whenever a personal hour cap override is approved.');
    }
  }

  if (draft.hourlyWageRate != null && Number(draft.hourlyWageRate) < 0) errors.push('Wage rate cannot be negative.');

  return errors;
}

export function isArchived(staffMember, todayIso) {
  return !!staffMember.endDate && staffMember.endDate <= todayIso;
}

// Archiving is the normal leaver path - keeps the full record (history,
// ledger references) intact, just marks them as no longer current.
export function archiveStaff(staffList, staffId, todayIso) {
  return staffList.map((s) => (s.id === staffId ? { ...s, endDate: todayIso } : s));
}

export function reinstateStaff(staffList, staffId) {
  return staffList.map((s) => (s.id === staffId ? { ...s, endDate: null } : s));
}

// Full GDPR erasure - removes the record entirely. Unlike archiving,
// this is deliberately NOT the default path (see project memory on
// staff lifecycle): it should only be used for a genuine erasure
// request, since it also breaks any historic reference to this staffId
// (ledger entries, past shifts) that assumed the record still existed.
export function deleteStaffGdpr(staffList, staffId) {
  return staffList.filter((s) => s.id !== staffId);
}

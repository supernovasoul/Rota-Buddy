// Pure logic for the opening-hours and shift-type-catalogue settings
// (Phase 4) - no DOM here, unit tested the same way staff.js is.
//
// Scope note for this increment: shiftTypeSets[] is meant to be
// versioned by effective date range (see app/data-model.md) so a shift
// shape change doesn't rewrite history - this file's helpers operate on
// a single already-resolved "current set" the caller passes in. Actually
// creating a SECOND version effective from a future date (the real
// versioning workflow) isn't built yet; for now the app keeps exactly
// one always-active set and edits it in place.

function isValidTime(t) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t ?? '');
}

export function validateOpeningHoursDefaults(defaultWeekday, defaultWeekend) {
  const errors = [];
  for (const [label, span] of [['Weekday', defaultWeekday], ['Weekend', defaultWeekend]]) {
    if (!isValidTime(span.start) || !isValidTime(span.end)) {
      errors.push(`${label} opening hours must be valid times (HH:MM).`);
    } else if (span.start >= span.end) {
      errors.push(`${label} opening hours: start must be before end.`);
    }
  }
  return errors;
}

export function newOverrideDraft() {
  return { date: '', start: '', end: '', closed: false, isSpecialDay: false, note: '' };
}

export function validateOverrideDraft(draft) {
  const errors = [];
  if (!draft.date) errors.push('A date is required for an opening-hours override.');
  if (!draft.closed) {
    if (!isValidTime(draft.start) || !isValidTime(draft.end)) {
      errors.push('Start and end times must be valid (HH:MM) unless this date is marked closed.');
    } else if (draft.start >= draft.end) {
      errors.push('Override start must be before end.');
    }
  }
  return errors;
}

// One override per date - saving a new one for a date that already has
// an override replaces it, rather than creating a confusing duplicate.
export function upsertOverride(overrides, draft) {
  const withoutThisDate = overrides.filter((o) => o.date !== draft.date);
  return [...withoutThisDate, draft].sort((a, b) => a.date.localeCompare(b.date));
}

export function removeOverride(overrides, date) {
  return overrides.filter((o) => o.date !== date);
}

export function newShiftTypeDraft() {
  return { id: null, name: '', start: '', end: '', breakMinutes: 0, slot: '' };
}

// role is optional context from the caller ('receptionist'|'therapist') -
// only reception shift types need a .slot (see app/data-model.md's
// shiftTypeSets doc), since that's what ties a shift type to the
// early/later/full recurring-pattern editor. Therapist shift types (and
// any caller not passing role at all) skip that check entirely.
export function validateShiftTypeDraft(draft, role) {
  const errors = [];
  if (!draft.name || !draft.name.trim()) errors.push('Shift type name is required.');
  if (!isValidTime(draft.start) || !isValidTime(draft.end)) {
    errors.push('Start and end times must be valid (HH:MM).');
  } else if (draft.start >= draft.end) {
    errors.push('Shift start must be before end.');
  }
  if (draft.breakMinutes === null || draft.breakMinutes === undefined || Number(draft.breakMinutes) < 0) {
    errors.push('Break minutes cannot be negative.');
  }
  if (role === 'receptionist' && !['early', 'later', 'full'].includes(draft.slot)) {
    errors.push('Choose which recurring-pattern slot (Early, Later, or Full day) this reception shift type belongs to.');
  }
  return errors;
}

// newId is injected (not imported from state.js) so this file has no
// dependency on the browser-only crypto global and stays trivially
// testable under node --test.
export function upsertShiftType(shiftTypes, draft, newId) {
  if (draft.id) {
    return shiftTypes.map((t) => (t.id === draft.id ? { ...draft } : t));
  }
  return [...shiftTypes, { ...draft, id: newId() }];
}

export function removeShiftType(shiftTypes, id) {
  return shiftTypes.filter((t) => t.id !== id);
}

export function validateWeeklyCapSetting(defaultCapHours) {
  const errors = [];
  if (defaultCapHours === null || defaultCapHours === undefined || Number(defaultCapHours) <= 0) {
    errors.push('The default weekly hour cap must be a positive number.');
  }
  return errors;
}

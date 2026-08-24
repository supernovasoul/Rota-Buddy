import { shiftTypePaidHours } from './shiftTypes.js';

// The 39h-by-default (fully configurable, never hardcoded) WEEKLY hour
// cap — a genuine hard rule: the solver must never produce a week that
// exceeds it for anyone. This is a business-policy cap, separate from the
// WTR 48h statutory average limit (not yet built — flagged as remaining
// work) which applies unconditionally to everyone.
//
// An approved override raises the cap to a specific, still-enforced
// ceiling for that person (weeklyHourCapOverride.capHours) — it is NOT an
// opt-out. Approving someone for extra hours still leaves a real limit in
// place; it just moves where that limit sits.
export function weeklyCapHours(staffMember, weeklyHourCapSetting) {
  if (staffMember.weeklyHourCapOverride?.approved) return staffMember.weeklyHourCapOverride.capHours;
  return weeklyHourCapSetting.defaultCapHours;
}

// assignedShiftTypes: the shift-type configs (see shiftTypeSets) a person
// is assigned to across the week, reception or therapist, however many
// and whatever their individual lengths. Always paid hours, matching
// weeklyCapHours' units — never wall-clock span.
export function weeklyPaidHours(assignedShiftTypes) {
  return assignedShiftTypes.reduce((sum, shiftType) => sum + shiftTypePaidHours(shiftType), 0);
}

// assignedShiftTypesByStaffId: { [staffId]: shiftType[] } for the week
// being checked. Returns violations only for people who are actually
// over their own effective cap — empty array = fully compliant. This is
// the hard-rule check a solver/test suite asserts zero violations
// against; it never adjusts anyone's hours itself.
export function weeklyCapViolations(staff, weeklyHourCapSetting, assignedShiftTypesByStaffId) {
  const violations = [];
  for (const s of staff) {
    const assigned = assignedShiftTypesByStaffId[s.id] ?? [];
    const hoursWorked = weeklyPaidHours(assigned);
    const capHours = weeklyCapHours(s, weeklyHourCapSetting);
    if (hoursWorked > capHours) {
      violations.push({ staffId: s.id, hoursWorked, capHours, overBy: hoursWorked - capHours });
    }
  }
  return violations;
}

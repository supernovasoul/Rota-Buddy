// Generic per-person weekly assignment state - role-agnostic (used for
// both reception and therapist scheduling). Tracks what's been assigned
// so far so hard-rule checks (rest, cap) and fairness scoring can see the
// running total without re-deriving it from scratch each time.

import { shiftTypePaidHours } from './shiftTypes.js';

export function emptyPersonState() {
  return { assignedShifts: [], paidHoursSoFar: 0, weekendPaidHoursSoFar: 0 };
}

export function cloneWeekState(weekState) {
  const clone = {};
  for (const [sid, s] of Object.entries(weekState)) {
    clone[sid] = { assignedShifts: [...s.assignedShifts], paidHoursSoFar: s.paidHoursSoFar, weekendPaidHoursSoFar: s.weekendPaidHoursSoFar };
  }
  return clone;
}

export function applyAssignment(weekState, dateIso, isWeekend, assignment) {
  for (const { shiftType, staffId } of assignment) {
    const state = weekState[staffId] ?? (weekState[staffId] = emptyPersonState());
    state.assignedShifts.push({ date: dateIso, start: shiftType.start, end: shiftType.end });
    const paid = shiftTypePaidHours(shiftType);
    state.paidHoursSoFar += paid;
    if (isWeekend) state.weekendPaidHoursSoFar += paid;
  }
}

export function removeAssignment(weekState, dateIso, isWeekend, assignment) {
  for (const { shiftType, staffId } of assignment) {
    const state = weekState[staffId];
    if (!state) continue;
    const idx = state.assignedShifts.findIndex((s) => s.date === dateIso && s.start === shiftType.start && s.end === shiftType.end);
    if (idx !== -1) state.assignedShifts.splice(idx, 1);
    const paid = shiftTypePaidHours(shiftType);
    state.paidHoursSoFar -= paid;
    if (isWeekend) state.weekendPaidHoursSoFar -= paid;
  }
}

export function totalPaidHours(weekState) {
  return Object.values(weekState).reduce((sum, s) => sum + s.paidHoursSoFar, 0);
}

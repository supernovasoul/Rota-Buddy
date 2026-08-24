// Turns a solveChainedWeeks preview into real rotaPeriods[]/shifts[]/
// assignments[] records - one rotaPeriod per week, matching the weekly
// granularity the ledger-close rule already uses (a week is what gets
// closed/banked, not a whole month). Generating a preview never touches
// these tables on its own; this is the separate "save it for real" step.

import { shiftTypePaidHours } from './engine/v2/shiftTypes.js';

export function periodsOverlappingRange(rotaPeriods, startDate, endDate) {
  return rotaPeriods.filter((p) => startDate <= p.endDate && p.startDate <= endDate);
}

// Saves every week in a chained-weeks result as a fresh 'draft' period,
// REPLACING any existing not-yet-closed period covering that exact week
// (a regenerate-and-resave is a genuine do-over, not a merge) - but
// refuses outright, saving nothing, if ANY week to be saved overlaps a
// period that's already 'closed'. A closed period is real banked
// history (see the ledger-close-rule project memory) and must never be
// silently overwritten by a fresh draft; the manager would need to
// choose a different, non-overlapping range instead.
export function saveChainedWeeksAsDraftPeriods({ rotaPeriods, shifts, assignments }, chainedWeeksResult, newId, nowIso) {
  for (const week of chainedWeeksResult.weeks) {
    const weekEnd = week.dates[week.dates.length - 1];
    const overlapping = periodsOverlappingRange(rotaPeriods, week.weekStart, weekEnd);
    const closedOverlap = overlapping.find((p) => p.status === 'closed');
    if (closedOverlap) {
      throw new Error(`The week of ${week.weekStart} overlaps a period that's already closed (${closedOverlap.startDate} to ${closedOverlap.endDate}) and can't be regenerated.`);
    }
  }

  let nextPeriods = rotaPeriods;
  let nextShifts = shifts;
  let nextAssignments = assignments;

  for (const week of chainedWeeksResult.weeks) {
    const weekEnd = week.dates[week.dates.length - 1];

    const stale = periodsOverlappingRange(nextPeriods, week.weekStart, weekEnd);
    const stalePeriodIds = new Set(stale.map((p) => p.id));
    nextPeriods = nextPeriods.filter((p) => !stalePeriodIds.has(p.id));
    const staleShiftIds = new Set(nextShifts.filter((s) => stalePeriodIds.has(s.periodId)).map((s) => s.id));
    nextShifts = nextShifts.filter((s) => !stalePeriodIds.has(s.periodId));
    nextAssignments = nextAssignments.filter((a) => !staleShiftIds.has(a.shiftId));

    const period = { id: newId(), startDate: week.weekStart, endDate: weekEnd, status: 'draft', closedAt: null, closedBy: null };
    nextPeriods = [...nextPeriods, period];

    for (let i = 0; i < week.dates.length; i++) {
      const date = week.dates[i];
      const daysByRole = [
        ['receptionist', week.reception.days[i].assignment],
        ['therapist', week.therapist.days[i].assignment],
      ];
      for (const [role, assignmentList] of daysByRole) {
        for (const { shiftType, staffId } of assignmentList) {
          const shift = { id: newId(), periodId: period.id, date, shiftTypeId: shiftType.id, roleRequired: role, isShadowSlot: false, shadowOfShiftId: null };
          nextShifts = [...nextShifts, shift];
          nextAssignments = [...nextAssignments, {
            id: newId(), shiftId: shift.id, staffId, status: 'assigned',
            plannedHours: shiftTypePaidHours(shiftType), actualHours: null, changeReason: null, changedAt: null,
          }];
        }
      }
    }
  }

  return { rotaPeriods: nextPeriods, shifts: nextShifts, assignments: nextAssignments };
}

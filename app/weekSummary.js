// Derives the "This week" dashboard summary from saved rota state - which
// period counts as "this week", whether it's fully covered, and the
// weekly staffing history restWeekNudge.js needs but has no opinion on
// how to build from rotaPeriods[]/shifts[]/assignments[].

export function pickCurrentPeriod(rotaPeriods, todayIso) {
  const sorted = [...rotaPeriods].sort((a, b) => a.startDate.localeCompare(b.startDate));
  return sorted.find((p) => p.startDate <= todayIso && todayIso <= p.endDate)
    ?? sorted.find((p) => p.startDate > todayIso)
    ?? sorted[sorted.length - 1]
    ?? null;
}

// A shift counts as unfilled once its (non-cancelled) assignment has no
// staffId - the same null-staffId shape solveChainedWeeks already uses
// for an infeasible day (see rotaPeriods.js), carried straight through
// into saved state rather than a separate flag.
export function periodCoverage(period, shifts, assignments) {
  if (!period) return { complete: true, unfilledCount: 0 };
  const shiftIds = new Set(shifts.filter((s) => s.periodId === period.id).map((s) => s.id));
  const unfilledCount = assignments.filter((a) => shiftIds.has(a.shiftId) && a.status !== 'cancelled' && !a.staffId).length;
  return { complete: unfilledCount === 0, unfilledCount };
}

// recentWeeks input for restWeekNudge's computeRestWeekNudges: every saved
// period starting before the given one, oldest first. A week a person
// worked zero shifts in (present in the period but with no assignment)
// looks identical here to a week that was simply never generated - both
// read as "no shifts that week" - so a gap in generation history can
// understate a streak, never overstate one. That's the safe direction for
// an advisory-only nudge to be wrong in.
export function buildRecentWeeks(rotaPeriods, shifts, assignments, beforePeriod) {
  if (!beforePeriod) return [];
  return rotaPeriods
    .filter((p) => p.startDate < beforePeriod.startDate)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .map((p) => {
      const shiftIds = new Set(shifts.filter((s) => s.periodId === p.id).map((s) => s.id));
      const staffIdsWithShifts = [...new Set(
        assignments
          .filter((a) => shiftIds.has(a.shiftId) && a.status !== 'cancelled' && a.staffId)
          .map((a) => a.staffId)
      )];
      return { weekStart: p.startDate, staffIdsWithShifts };
    });
}

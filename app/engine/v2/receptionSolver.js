// Reception day-level mechanics and the full-week solver. Day resolution
// (open/closed, valid coverage combos) and day-option generation are
// reception-specific; the actual solving algorithm lives in weekSolver.js
// and is shared with the therapist side.

import { resolveOpeningHours, resolveShiftTypeSet } from './shiftTypes.js';
import { findCoveringCombinations } from './coverage.js';
import { isoWeekday } from '../eligibility.js';
import { buildReceptionEntitlement, scoreReceptionFairnessState } from './receptionFairness.js';
import { totalPaidHours } from './weekState.js';
import { solveWeek, DEFAULT_COST_TIEBREAK_WEIGHT } from './weekSolver.js';

export { canAssign, feasibleAssignmentsForCombo } from './assignment.js';
import { feasibleAssignmentsForCombo } from './assignment.js';

// What a day looks like before anyone's assigned: whether the spa is
// open, and every valid no-gap shift-type combination that could cover
// it. Throws if no shiftTypeSet is configured for the date at all -
// that's a genuine configuration gap, not a schedule gap, and shouldn't
// be silently treated as "no coverage needed."
export function resolveReceptionDay(dateIso, openingHours, shiftTypeSets, isWeekend) {
  const opening = resolveOpeningHours(openingHours, dateIso, isWeekend);
  if (opening.closed) {
    return { date: dateIso, closed: true, opening, combos: [] };
  }
  const activeSet = resolveShiftTypeSet(shiftTypeSets, dateIso);
  if (!activeSet) {
    throw new Error(`No shiftTypeSet configured for ${dateIso}`);
  }
  const combos = findCoveringCombinations(activeSet.receptionShiftTypes, opening.start, opening.end);
  return { date: dateIso, closed: false, opening, combos };
}

// For a day, every (combo, feasible assignment) pair that's actually
// staffable. A day with zero entries here - even if resolveReceptionDay
// found valid coverage combos in the abstract - means no one can safely
// cover it today without breaking a hard rule; that's a genuine gap.
export function feasibleDayOptions(dayContext, receptionists, weekStateByStaffId, eligibility, weeklyHourCapSetting) {
  if (dayContext.closed) return [];
  const options = [];
  for (const combo of dayContext.combos) {
    const assignments = feasibleAssignmentsForCombo(
      combo, dayContext.date, receptionists, weekStateByStaffId, eligibility, weeklyHourCapSetting
    );
    for (const assignment of assignments) {
      options.push({ combo, assignment });
    }
  }
  return options;
}

// FAIRNESS DECIDES WHO AND HOW MUCH; COST ONLY DECIDES THE SHAPE, AFTER.
// This combines the real objective (fairness deviation) with a tiny
// secondary preference for fewer total paid hours delivered - the same
// role solve_rota.py's STEP 7b tie-breaker plays for shift counts, and
// for the same reason: without it, a split that scores no worse than
// whole-day on fairness alone has nothing pushing the solver toward the
// cheaper option, even though "whole day whenever it fits, split as
// fallback" was the stated default.
//
// The weight is deliberately tiny relative to fairness deviations (which
// are driven by real, sub-hour-granular hour quantities, so meaningful
// differences are never smaller than ~0.1h) so it can only ever break a
// GENUINE tie, never override a real fairness difference: the maximum
// possible cost gap between two options is a few hours, so at this
// weight the tie-breaker's whole contribution tops out around 0.001 -
// two orders of magnitude below any real fairness difference. Concretely:
// this must never cause a person who's constrained to splits (e.g. by
// weekly cap or rest) to end up with fewer hours than pure fairness would
// give them - see receptionSolver.test.js's tiebreak-neutrality test,
// which runs the same scenario with this weight on and off and asserts a
// split-only-capable person's final hours are identical either way.
export function solveReceptionWeek({
  dates, openingHours, shiftTypeSets, receptionists, eligibility, weeklyHourCapSetting, existingBalance, isExempt,
  maxSweeps = 10, costTiebreakWeight = DEFAULT_COST_TIEBREAK_WEIGHT,
}) {
  const dayContexts = dates.map((date) => {
    const isWeekend = isoWeekday(date) >= 5;
    return { ...resolveReceptionDay(date, openingHours, shiftTypeSets, isWeekend), isWeekend };
  });

  const entitlement = buildReceptionEntitlement(dayContexts, receptionists, eligibility);

  function scoreState(staff, trialState) {
    const fairness = scoreReceptionFairnessState(staff, entitlement, existingBalance, isExempt, trialState).total;
    return fairness + totalPaidHours(trialState) * costTiebreakWeight;
  }

  const { days, weekState } = solveWeek({
    dayContexts,
    staff: receptionists,
    eligibility,
    weeklyHourCapSetting,
    generateDayOptions: feasibleDayOptions,
    scoreState,
    maxSweeps,
  });

  return { days, weekState, entitlement };
}

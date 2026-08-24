// Therapist day-level mechanics and the full-week solver. Reception must
// search combinations of shift types because covering the desk with no
// gap is a hard structural rule shared between whoever's on it that day.
// Therapists have no such shared constraint - any number of people can
// work independently of each other, and a day can genuinely mix shift
// lengths (a 6h shift for one person, a 9h shift for another, same day).
//
// Because of that, the day decomposes cleanly: the fairness objective is
// just a sum of each person's OWN deviation from their OWN entitlement
// (see therapistFairness.js) - there's no cross-person interaction to
// search over. So the best choice for the whole team, on any given day,
// is exactly each person's own best choice, computed independently:
// no-shift, or whichever available shift type brings THEIR running
// total closest to their fair share. Adding a shift of h hours changes a
// person's own |deviation| from |dev| to |dev+h| - nobody else's terms
// change - so there is nothing to gain by ever giving someone a shift
// that isn't their own individual best option. Unlike reception's
// feasibleDayOptions (which returns every valid combo+assignment for the
// caller to score), this always returns a single composite option - the
// composite IS the optimum, not one candidate among several.
//
// Rest weeks (flex staff being kept off the rota periodically so a
// continuous schedule doesn't start to look like disguised permanent
// employment) need no special handling here either: a person on a
// planned rest week is simply not eligible that week, so they fall
// behind their entitlement, and the same "give it to whoever's most
// behind" logic naturally catches them up afterward. See
// restWeekNudge.js for the advisory (non-solver-forced) side of that.

import { isoWeekday } from '../eligibility.js';
import { resolveOpeningHours, resolveShiftTypeSet, shiftTypePaidHours } from './shiftTypes.js';
import { demandForDay, buildTherapistEntitlement, scoreTherapistFairnessState } from './therapistFairness.js';
import { totalPaidHours } from './weekState.js';
import { solveWeek, DEFAULT_COST_TIEBREAK_WEIGHT } from './weekSolver.js';
import { canAssign } from './assignment.js';

export { canAssign } from './assignment.js';

// What a day looks like before anyone's assigned: whether the spa is
// open, that day's raw demand, and every therapist shift type currently
// configured (all of them are live candidates for any day - unlike
// reception's opening-hours-driven combo search, there's no structural
// reason to restrict which types apply to which day; a spa might run a
// 6h and a 9h type side by side all week). Throws if no shiftTypeSet is
// configured for the date at all - a genuine configuration gap, not a
// schedule gap.
export function resolveTherapistDay(dateIso, openingHours, shiftTypeSets, isWeekend, demandHours) {
  const opening = resolveOpeningHours(openingHours, dateIso, isWeekend);
  if (opening.closed) {
    return { date: dateIso, closed: true, demandHours: 0, shiftTypes: [] };
  }
  const activeSet = resolveShiftTypeSet(shiftTypeSets, dateIso);
  if (!activeSet) {
    throw new Error(`No shiftTypeSet configured for ${dateIso}`);
  }
  return { date: dateIso, closed: false, demandHours, shiftTypes: activeSet.therapistShiftTypes };
}

// The day's one true composite option - see file header for why no
// search over alternatives is needed. entitlement/existingBalance are
// passed via an options bag (not positional) since they're specific to
// the therapist week-level entitlement calc, not part of the generic
// weekSolver.generateDayOptions signature reception also uses.
export function feasibleDayOptions(dayContext, therapists, weekStateByStaffId, eligibility, weeklyHourCapSetting, { entitlement, existingBalance }) {
  if (dayContext.closed) return [];

  const assignment = [];
  for (const person of therapists) {
    const state = weekStateByStaffId[person.id] ?? { assignedShifts: [], paidHoursSoFar: 0 };
    const dev = existingBalance(person.id, 'THER_HOURS') + state.paidHoursSoFar - (entitlement[person.id]?.THER_HOURS ?? 0);

    // "no shift" is always a candidate - nobody's forced to work.
    const candidates = [{ gain: 0, score: Math.abs(dev), shiftType: null }];
    for (const shiftType of dayContext.shiftTypes) {
      if (!canAssign(person, shiftType, dayContext.date, state, eligibility, weeklyHourCapSetting)) continue;
      const gain = shiftTypePaidHours(shiftType);
      candidates.push({ gain, score: Math.abs(dev + gain), shiftType });
    }

    // lowest deviation wins outright; an exact tie prefers the cheaper
    // (smaller-gain) option - same "fairness decides how much, cost only
    // breaks a genuine tie" rule reception's tiebreak follows.
    candidates.sort((a, b) => {
      if (Math.abs(a.score - b.score) > 1e-9) return a.score - b.score;
      return a.gain - b.gain;
    });
    const best = candidates[0];
    if (best.shiftType) assignment.push({ shiftType: best.shiftType, staffId: person.id });
  }

  return [{ assignment }];
}

export function solveTherapistWeek({
  dates, openingHours, shiftTypeSets, therapists, eligibility, weeklyHourCapSetting, demand, existingBalance, isExempt,
  maxSweeps = 10, costTiebreakWeight = DEFAULT_COST_TIEBREAK_WEIGHT,
}) {
  const dayContexts = dates.map((date) => {
    const isWeekend = isoWeekday(date) >= 5;
    const demandHours = demandForDay(demand, date);
    return { ...resolveTherapistDay(date, openingHours, shiftTypeSets, isWeekend, demandHours), isWeekend };
  });

  const entitlement = buildTherapistEntitlement(dayContexts, therapists, eligibility);

  function generateDayOptions(dayContext, staff, weekStateByStaffId, eligibilityArg, weeklyHourCapSettingArg) {
    return feasibleDayOptions(dayContext, staff, weekStateByStaffId, eligibilityArg, weeklyHourCapSettingArg, { entitlement, existingBalance });
  }

  // No cross-person "who catches up first" tiebreak is needed here (unlike
  // reception's cost tiebreak, which genuinely resolves ties between
  // combos): each person's own best allocation is already fully determined
  // by their own dev/entitlement/cap alone (see feasibleDayOptions), with
  // zero reference to anyone else's numbers, so two people can only ever
  // land on the same total by each independently earning it (e.g. both
  // simply hitting the same weekly cap ceiling) - never by an ambiguous
  // split of a shared amount that a tiebreak would need to arbitrate.
  function scoreState(staff, trialState) {
    const fairness = scoreTherapistFairnessState(staff, entitlement, existingBalance, isExempt, trialState).total;
    return fairness + totalPaidHours(trialState) * costTiebreakWeight;
  }

  const { days, weekState } = solveWeek({
    dayContexts,
    staff: therapists,
    eligibility,
    weeklyHourCapSetting,
    generateDayOptions,
    scoreState,
    maxSweeps,
  });

  return { days, weekState, entitlement };
}

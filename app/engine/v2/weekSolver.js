// Generic week-solving engine - role agnostic. Solves a week in three
// phases and hands back a per-day assignment plus the final week state.
// Both reception and therapist scheduling plug their own day-option
// generation and fairness/cost scoring into this; the search algorithm
// itself (and its accumulated bug fixes - see phase 3's history) is
// shared rather than duplicated.
//
// Phase 1 is a greedy day-by-day construction: for each day in order,
// pick whichever feasible option leaves the lowest score SO FAR. That
// comparison is necessarily myopic early in the week - actual progress so
// far is compared against the FULL week's entitlement, so day one can
// look artificially different purely because nothing else has been
// decided yet. Phase 2 corrects that: repeated coordinate-descent sweeps
// revisit each day given every OTHER day's now-settled assignment and
// re-pick whichever feasible option minimises the TRUE final score.
// Phase 3 goes further: some improvements need TWO days to change at
// once (e.g. converting two needless split days into two whole-days for
// two different people is a net win, but changing just one of them in
// isolation looks worse, since it over-serves one person before the
// other day compensates) - single-day descent alone can get stuck short
// of those, so phase 3 tries every pair of open days jointly. The two
// local-search phases alternate, since a pairwise move can expose new
// single-day improvements and vice versa, until a full round finds
// nothing or maxRounds is hit.
//
// A day with no feasible option at all is reported as a genuine gap,
// never silently dropped or given to someone ineligible.

import { emptyPersonState, cloneWeekState, applyAssignment, removeAssignment } from './weekState.js';

// Shared secondary tie-break weight: prefer fewer total paid hours only
// when the real objective (fairness deviation) is otherwise tied - never
// large enough to override a genuine fairness difference. See
// receptionSolver.js's tiebreak-neutrality test for why this magnitude
// is safe.
export const DEFAULT_COST_TIEBREAK_WEIGHT = 1e-4;

export function solveWeek({
  dayContexts, staff, eligibility, weeklyHourCapSetting,
  generateDayOptions,  // (dayContext, staff, weekStateByStaffId, eligibility, weeklyHourCapSetting) -> [{ assignment: [{shiftType, staffId}, ...], ...roleSpecificFields }]
  scoreState,          // (staff, weekStateByStaffId) -> number, lower is better, already includes any cost tie-breaking
  maxSweeps = 10,
  maxRounds = 3,
}) {
  let weekState = {};
  for (const s of staff) weekState[s.id] = emptyPersonState();

  const days = [];

  // Phase 1: greedy construction.
  for (const day of dayContexts) {
    if (day.closed) {
      days.push({ date: day.date, closed: true, unfilled: false, assignment: [] });
      continue;
    }

    const options = generateDayOptions(day, staff, weekState, eligibility, weeklyHourCapSetting);
    if (options.length === 0) {
      days.push({ date: day.date, closed: false, unfilled: true, assignment: [] });
      continue;
    }

    let best = null;
    let bestScore = Infinity;
    for (const option of options) {
      const trialState = cloneWeekState(weekState);
      applyAssignment(trialState, day.date, day.isWeekend, option.assignment);
      const score = scoreState(staff, trialState);
      if (score < bestScore) {
        bestScore = score;
        best = option;
      }
    }

    applyAssignment(weekState, day.date, day.isWeekend, best.assignment);
    days.push({ date: day.date, closed: false, unfilled: false, assignment: best.assignment });
  }

  // Phase 2: single-day coordinate-descent sweeps.
  function runSingleDaySweeps() {
    let anyChange = false;
    let changed = true;
    let sweep = 0;
    while (changed && sweep < maxSweeps) {
      changed = false;
      sweep++;

      for (let i = 0; i < dayContexts.length; i++) {
        const day = dayContexts[i];
        if (day.closed) continue;

        const stateWithoutThisDay = cloneWeekState(weekState);
        removeAssignment(stateWithoutThisDay, day.date, day.isWeekend, days[i].assignment);

        const currentScore = scoreState(staff, weekState);
        const options = generateDayOptions(day, staff, stateWithoutThisDay, eligibility, weeklyHourCapSetting);

        let bestOption = null;
        let bestScore = currentScore;
        for (const option of options) {
          const trialState = cloneWeekState(stateWithoutThisDay);
          applyAssignment(trialState, day.date, day.isWeekend, option.assignment);
          const score = scoreState(staff, trialState);
          if (score < bestScore - 1e-9) {
            bestScore = score;
            bestOption = option;
          }
        }

        if (bestOption) {
          weekState = cloneWeekState(stateWithoutThisDay);
          applyAssignment(weekState, day.date, day.isWeekend, bestOption.assignment);
          days[i] = { date: day.date, closed: false, unfilled: false, assignment: bestOption.assignment };
          changed = true;
          anyChange = true;
        }
      }
    }
    return anyChange;
  }

  // Phase 3: pairwise joint local search.
  function runPairwiseSweeps() {
    let anyChange = false;
    let changed = true;
    let sweep = 0;
    while (changed && sweep < maxSweeps) {
      changed = false;
      sweep++;

      for (let i = 0; i < dayContexts.length; i++) {
        if (dayContexts[i].closed) continue;
        for (let j = i + 1; j < dayContexts.length; j++) {
          if (dayContexts[j].closed) continue;

          const dayI = dayContexts[i];
          const dayJ = dayContexts[j];
          const stateWithoutBoth = cloneWeekState(weekState);
          removeAssignment(stateWithoutBoth, dayI.date, dayI.isWeekend, days[i].assignment);
          removeAssignment(stateWithoutBoth, dayJ.date, dayJ.isWeekend, days[j].assignment);

          const currentScore = scoreState(staff, weekState);
          const optionsI = generateDayOptions(dayI, staff, stateWithoutBoth, eligibility, weeklyHourCapSetting);

          let bestPair = null;
          let bestScore = currentScore;
          for (const optionI of optionsI) {
            const stateAfterI = cloneWeekState(stateWithoutBoth);
            applyAssignment(stateAfterI, dayI.date, dayI.isWeekend, optionI.assignment);
            const optionsJ = generateDayOptions(dayJ, staff, stateAfterI, eligibility, weeklyHourCapSetting);
            for (const optionJ of optionsJ) {
              const trial = cloneWeekState(stateAfterI);
              applyAssignment(trial, dayJ.date, dayJ.isWeekend, optionJ.assignment);
              const score = scoreState(staff, trial);
              if (score < bestScore - 1e-9) {
                bestScore = score;
                bestPair = { optionI, optionJ };
              }
            }
          }

          if (bestPair) {
            weekState = cloneWeekState(stateWithoutBoth);
            applyAssignment(weekState, dayI.date, dayI.isWeekend, bestPair.optionI.assignment);
            applyAssignment(weekState, dayJ.date, dayJ.isWeekend, bestPair.optionJ.assignment);
            days[i] = { date: dayI.date, closed: false, unfilled: false, assignment: bestPair.optionI.assignment };
            days[j] = { date: dayJ.date, closed: false, unfilled: false, assignment: bestPair.optionJ.assignment };
            changed = true;
            anyChange = true;
          }
        }
      }
    }
    return anyChange;
  }

  let anyChangeThisRound = true;
  let round = 0;
  while (anyChangeThisRound && round < maxRounds) {
    const a = runSingleDaySweeps();
    const b = runPairwiseSweeps();
    anyChangeThisRound = a || b;
    round++;
  }

  return { days, weekState };
}

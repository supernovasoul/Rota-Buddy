// Reception fairness (v2): hours-based, two dimensions - REC_HOURS (a
// general pool, direct analog of THER_HOURS) and REC_WEEKEND (still
// well-defined independent of which combo runs, since a day is either a
// weekend day or not). REC_EARLY/REC_LATE are retired: they only ever
// made sense when "early" and "late" were fixed, named slots, and
// there's no principled way to call a Whole day shift "early" or "late".
//
// Entitlement is computed ONCE up front, independent of which combo the
// solver ends up choosing each day, to avoid circularity: a person's fair
// share of a day's cost is based on that day's REFERENCE coverage cost
// (the cheapest valid combo's total paid hours - normally whole-day,
// since a split's handover overlap costs more paid hours than covering
// the same span with one person), split among everyone plainly
// day-eligible (available, started, not forced off) — NOT filtered by
// rest/cap, since being unable to take THIS particular day's shift
// doesn't remove someone from the fairness pool, matching how the old
// model's fair share worked.
//
// The split is WEIGHTED by each person's priorityWeight (neutral = 1.0;
// see project memory on priority weighting) rather than a plain equal
// share - this is the "bigger fair-share entitlement for favoured staff"
// mechanism: a weight of 2.0 gives someone roughly double a neutral
// colleague's share of each day, self-correcting over time through the
// same rolling-ledger deviation logic everyone else uses, never an
// always-pick-first override.

import { combinationPaidHours } from './coverage.js';

export function referenceCostForDay(dayContext) {
  if (dayContext.closed || dayContext.combos.length === 0) return 0;
  return Math.min(...dayContext.combos.map((c) => combinationPaidHours(c)));
}

// dayContexts: [{ date, closed, combos, isWeekend }] for the week, in order
export function buildReceptionEntitlement(dayContexts, receptionists, eligibility) {
  const entitlement = {};
  for (const s of receptionists) entitlement[s.id] = { REC_HOURS: 0, REC_WEEKEND: 0 };

  for (const day of dayContexts) {
    if (day.closed) continue;
    const cost = referenceCostForDay(day);
    const eligibleToday = receptionists.filter((s) => eligibility.isEligible(s.id, day.date));
    if (eligibleToday.length === 0) continue;
    const totalWeight = eligibleToday.reduce((sum, s) => sum + (s.priorityWeight ?? 1.0), 0) || 1;
    for (const s of eligibleToday) {
      const share = cost * ((s.priorityWeight ?? 1.0) / totalWeight);
      entitlement[s.id].REC_HOURS += share;
      if (day.isWeekend) entitlement[s.id].REC_WEEKEND += share;
    }
  }
  return entitlement;
}

// weekStateByStaffId: { [staffId]: { paidHoursSoFar, weekendPaidHoursSoFar } }
export function scoreReceptionFairnessState(receptionists, entitlement, existingBalance, isExempt, weekStateByStaffId) {
  let total = 0;
  const perPerson = {};
  for (const s of receptionists) {
    const state = weekStateByStaffId[s.id] ?? { paidHoursSoFar: 0, weekendPaidHoursSoFar: 0 };

    if (!isExempt(s.id, 'REC_HOURS')) {
      const dev = existingBalance(s.id, 'REC_HOURS') + state.paidHoursSoFar - (entitlement[s.id]?.REC_HOURS ?? 0);
      total += Math.abs(dev);
      perPerson[`${s.id}:REC_HOURS`] = dev;
    }
    if (!isExempt(s.id, 'REC_WEEKEND')) {
      const dev = existingBalance(s.id, 'REC_WEEKEND') + state.weekendPaidHoursSoFar - (entitlement[s.id]?.REC_WEEKEND ?? 0);
      total += Math.abs(dev);
      perPerson[`${s.id}:REC_WEEKEND`] = dev;
    }
  }
  return { total, perPerson };
}

// Therapist fairness (v2): a single hours-based dimension, THER_HOURS -
// unchanged in shape from the old model (already hours-based, unlike
// reception's old shift-count dimensions), just driven by real demand[]
// input and real shift-type paid hours instead of the old deterministic
// weekday/weekend rule and flexible 0-8h IntVars.
//
// Entitlement mirrors app/solver_reference.py's therapist formula, with
// one addition: for each day a person is eligible, their share of that
// day's RAW demand (not clamped to capacity - see demandForDay) is
// proportional to their contracted fraction WEIGHTED by their
// priorityWeight (neutral = 1.0; see project memory on priority
// weighting), among everyone else eligible that day, summed across the
// week. A weight above 1.0 gives someone a bigger share of each day than
// their contracted fraction alone would - self-correcting over time via
// the same rolling-ledger deviation logic, never an always-pick-first
// override.

export function demandForDay(demand, dateIso) {
  const entry = demand.find((d) => d.date === dateIso);
  if (!entry) return 0;
  return entry.overrideHours ?? entry.forecastHours ?? 0;
}

function weightedShare(person) {
  return (person.proportionalFraction ?? 0) * (person.priorityWeight ?? 1.0);
}

// dayContexts: [{ date, closed, isWeekend, demandHours }] for the week, in order
export function buildTherapistEntitlement(dayContexts, therapists, eligibility) {
  const entitlement = {};
  for (const t of therapists) entitlement[t.id] = { THER_HOURS: 0 };

  for (const day of dayContexts) {
    if (day.closed || day.demandHours <= 0) continue;
    const pool = therapists.filter((t) => eligibility.isEligible(t.id, day.date));
    const totalWeight = pool.reduce((sum, t) => sum + weightedShare(t), 0) || 1;
    for (const t of pool) {
      entitlement[t.id].THER_HOURS += day.demandHours * (weightedShare(t) / totalWeight);
    }
  }
  return entitlement;
}

export function scoreTherapistFairnessState(therapists, entitlement, existingBalance, isExempt, weekStateByStaffId) {
  let total = 0;
  const perPerson = {};
  for (const t of therapists) {
    if (isExempt(t.id, 'THER_HOURS')) continue;
    const state = weekStateByStaffId[t.id] ?? { paidHoursSoFar: 0 };
    const dev = existingBalance(t.id, 'THER_HOURS') + state.paidHoursSoFar - (entitlement[t.id]?.THER_HOURS ?? 0);
    total += Math.abs(dev);
    perPerson[t.id] = dev;
  }
  return { total, perPerson };
}

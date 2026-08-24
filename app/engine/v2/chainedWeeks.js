// Solves several weeks in sequence, chaining the fairness ledger forward
// week to week WITHOUT writing anything to the real ledgerEvents[] - see
// project memory on the ledger-close rule: nothing is actually banked
// until a manager confirms a week finished, which can be well after
// generation (and after manual edits). This lets "generate a month" feel
// like one continuous solve while staying entirely a draft until closed.
//
// Mechanism: start from the REAL existingBalance (from closed ledger
// history), then after each week solves, add that week's own
// entitlement-deviation (actual hours minus what they were entitled to,
// exactly the same "dev" the solvers already compute internally) into a
// running draft delta. The next week's solve sees realBalance + all
// draft deltas so far as its existingBalance - so someone under-served
// in week 1 is correctly favoured in week 2, purely within this one
// generation pass.

import { datesOfWeek } from '../eligibility.js';
import { solveReceptionWeek } from './receptionSolver.js';
import { solveTherapistWeek } from './therapistSolver.js';
import { buildExistingBalanceLookup } from './ledger.js';

export function solveChainedWeeks({
  weekStarts, openingHours, shiftTypeSets, receptionists, therapists, eligibility,
  weeklyHourCapSetting, demand, ledgerEvents, isExempt,
}) {
  const realBalance = buildExistingBalanceLookup(ledgerEvents);
  const draftDelta = {}; // staffId -> { [dimensionCode]: cumulative delta so far }

  function combinedBalance(staffId, dimensionCode) {
    return realBalance(staffId, dimensionCode) + (draftDelta[staffId]?.[dimensionCode] ?? 0);
  }

  function addDelta(staffId, dimensionCode, amount) {
    if (!draftDelta[staffId]) draftDelta[staffId] = {};
    draftDelta[staffId][dimensionCode] = (draftDelta[staffId][dimensionCode] ?? 0) + amount;
  }

  const weeks = [];
  for (const weekStart of weekStarts) {
    const dates = datesOfWeek(weekStart);

    const reception = solveReceptionWeek({
      dates, openingHours, shiftTypeSets, receptionists, eligibility, weeklyHourCapSetting,
      existingBalance: combinedBalance, isExempt,
    });
    for (const s of receptionists) {
      const state = reception.weekState[s.id] ?? { paidHoursSoFar: 0, weekendPaidHoursSoFar: 0 };
      addDelta(s.id, 'REC_HOURS', state.paidHoursSoFar - (reception.entitlement[s.id]?.REC_HOURS ?? 0));
      addDelta(s.id, 'REC_WEEKEND', state.weekendPaidHoursSoFar - (reception.entitlement[s.id]?.REC_WEEKEND ?? 0));
    }

    const therapist = solveTherapistWeek({
      dates, openingHours, shiftTypeSets, therapists, eligibility, weeklyHourCapSetting, demand,
      existingBalance: combinedBalance, isExempt,
    });
    for (const t of therapists) {
      const state = therapist.weekState[t.id] ?? { paidHoursSoFar: 0 };
      addDelta(t.id, 'THER_HOURS', state.paidHoursSoFar - (therapist.entitlement[t.id]?.THER_HOURS ?? 0));
    }

    weeks.push({ weekStart, dates, reception, therapist });
  }

  return { weeks, finalBalance: combinedBalance };
}

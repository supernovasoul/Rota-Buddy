// Closes a rota period for real: banks actual worked hours into
// ledgerEvents[] (see the ledger-close-rule project memory - this is
// the step that memory flagged as missing). Entitlement is RECOMPUTED
// here from the current state, not carried over from whatever the
// generation preview used - if the manager corrected availability or
// staff data after generating (a legitimate workflow now that Phase 7
// manual editing exists), closing should bank against the latest known
// truth, not a possibly-stale snapshot from generation time. Actual
// hours come from the saved assignments' actualHours (or plannedHours
// as a fallback for anything still untouched) - a manager-set
// 'cancelled'/'reduced' status is left alone, not promoted to 'worked'.

import { isoWeekday, datesOfWeek, buildEligibility } from './engine/eligibility.js';
import { resolveReceptionDay } from './engine/v2/receptionSolver.js';
import { resolveTherapistDay } from './engine/v2/therapistSolver.js';
import { buildReceptionEntitlement } from './engine/v2/receptionFairness.js';
import { buildTherapistEntitlement, demandForDay } from './engine/v2/therapistFairness.js';

export function closePeriod(state, periodId, newId, nowIso) {
  const period = state.rotaPeriods.find((p) => p.id === periodId);
  if (!period) throw new Error('That rota period no longer exists.');
  if (period.status === 'closed') throw new Error('This period is already closed.');

  // periods are always exactly one Mon-Sun week (see rotaPeriods.js)
  const dates = datesOfWeek(period.startDate);
  const eligibility = buildEligibility(state);
  const receptionists = state.staff.filter((s) => s.role === 'receptionist');
  const therapists = state.staff.filter((s) => s.role === 'therapist');

  const receptionDayContexts = dates.map((date) => {
    const isWeekend = isoWeekday(date) >= 5;
    return { ...resolveReceptionDay(date, state.openingHours, state.shiftTypeSets, isWeekend), isWeekend };
  });
  const receptionEntitlement = buildReceptionEntitlement(receptionDayContexts, receptionists, eligibility);

  const therapistDayContexts = dates.map((date) => {
    const isWeekend = isoWeekday(date) >= 5;
    return { ...resolveTherapistDay(date, state.openingHours, state.shiftTypeSets, isWeekend, demandForDay(state.demand, date)), isWeekend };
  });
  const therapistEntitlement = buildTherapistEntitlement(therapistDayContexts, therapists, eligibility);

  const periodShiftIds = new Set(state.shifts.filter((s) => s.periodId === periodId).map((s) => s.id));
  const shiftById = new Map(state.shifts.map((s) => [s.id, s]));

  const updatedAssignments = state.assignments.map((a) => {
    if (!periodShiftIds.has(a.shiftId)) return a;
    // Only a still-'assigned' row gets promoted to 'worked' here - a
    // manager-set 'cancelled'/'reduced' status (Phase 7) is real edit
    // history and must survive a close untouched.
    const status = a.status === 'assigned' ? 'worked' : a.status;
    return { ...a, status, actualHours: a.actualHours ?? a.plannedHours };
  });

  const actualByStaffDim = {}; // staffId -> { [dimensionCode]: hours }
  function addActual(staffId, dimensionCode, hours) {
    if (!actualByStaffDim[staffId]) actualByStaffDim[staffId] = {};
    actualByStaffDim[staffId][dimensionCode] = (actualByStaffDim[staffId][dimensionCode] ?? 0) + hours;
  }
  for (const a of updatedAssignments) {
    if (!periodShiftIds.has(a.shiftId)) continue;
    const shift = shiftById.get(a.shiftId);
    if (shift.roleRequired === 'receptionist') {
      addActual(a.staffId, 'REC_HOURS', a.actualHours);
      if (isoWeekday(shift.date) >= 5) addActual(a.staffId, 'REC_WEEKEND', a.actualHours);
    } else {
      addActual(a.staffId, 'THER_HOURS', a.actualHours);
    }
  }

  function ledgerEventIfMeaningful(staffId, dimensionCode, entitled, actual) {
    if (entitled === 0 && actual === 0) return null; // nothing to record - this person had no stake in this dimension this period
    return { id: newId(), staffId, dimensionId: dimensionCode, periodId, entitled, actual, eventType: 'period_close', note: '', createdAt: nowIso };
  }

  const newLedgerEvents = [];
  for (const s of receptionists) {
    const recHours = ledgerEventIfMeaningful(s.id, 'REC_HOURS', receptionEntitlement[s.id]?.REC_HOURS ?? 0, actualByStaffDim[s.id]?.REC_HOURS ?? 0);
    if (recHours) newLedgerEvents.push(recHours);
    const recWeekend = ledgerEventIfMeaningful(s.id, 'REC_WEEKEND', receptionEntitlement[s.id]?.REC_WEEKEND ?? 0, actualByStaffDim[s.id]?.REC_WEEKEND ?? 0);
    if (recWeekend) newLedgerEvents.push(recWeekend);
  }
  for (const t of therapists) {
    const therHours = ledgerEventIfMeaningful(t.id, 'THER_HOURS', therapistEntitlement[t.id]?.THER_HOURS ?? 0, actualByStaffDim[t.id]?.THER_HOURS ?? 0);
    if (therHours) newLedgerEvents.push(therHours);
  }

  const updatedPeriods = state.rotaPeriods.map((p) => (p.id === periodId ? { ...p, status: 'closed', closedAt: nowIso, closedBy: null } : p));

  return {
    rotaPeriods: updatedPeriods,
    assignments: updatedAssignments,
    ledgerEvents: [...state.ledgerEvents, ...newLedgerEvents],
  };
}

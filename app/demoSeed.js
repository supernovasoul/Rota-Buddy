// Builds a fully populated demo state for a fresh install with nothing in
// localStorage yet - so anyone opening the deployed app sees a working
// example (fictional staff, a real generated rota, banked history) instead
// of an empty shell. Runs the app's own generation pipeline rather than
// hand-typing rota output, so the demo is always internally consistent with
// whatever the solver currently does. None of these names are real people.

import { emptyState, newId, todayIso } from './state.js';
import { buildEligibility, isoWeekday } from './engine/eligibility.js';
import { solveChainedWeeks } from './engine/v2/chainedWeeks.js';
import { weekStartsForMonth } from './rotaGeneration.js';
import { saveChainedWeeksAsDraftPeriods } from './rotaPeriods.js';
import { closePeriod } from './rotaClose.js';

const DEMO_RECEPTIONISTS = [
  { name: 'Alex Morgan', employmentType: 'flex', days: [0, 1, 2, 3, 4] },
  { name: 'Jordan Reyes', employmentType: 'flex', days: [2, 3, 4, 5, 6] },
  { name: 'Priya Anand', employmentType: 'fixed_pattern', days: [0, 1, 3, 4] },
  { name: 'Sam Whitfield', employmentType: 'fixed_pattern', days: [1, 2, 3, 4, 5] },
  { name: 'Casey Nakamura', employmentType: 'flex', days: null }, // no pattern = available every day
  { name: 'Riley Osei', employmentType: 'flex', days: [0, 5, 6] },
];

const DEMO_THERAPISTS = [
  { name: 'Dana Kowalski', employmentType: 'flex', proportionalFraction: 1.0, days: null },
  { name: 'Robin Ahmed', employmentType: 'flex', proportionalFraction: 0.6, days: [0, 2, 4] },
  { name: 'Skyler Novak', employmentType: 'fixed_pattern', proportionalFraction: 0.5, days: [1, 3, 5] },
];

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function shiftMonth(baseIso, deltaMonths) {
  const d = new Date(`${baseIso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + deltaMonths);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

export function buildDemoState() {
  const state = emptyState();
  const today = todayIso();

  const staffStart = isoDate((() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return d;
  })());

  function makeStaff({ name, role, employmentType, proportionalFraction = null }) {
    return {
      id: newId(), name, role, startDate: staffStart, endDate: null,
      employmentType, proportionalFraction,
      weeklyHourCapOverride: null, priorityWeight: 1.0, priorityWeightReason: null,
      hourlyWageRate: null, restWeekPolicyOverride: null,
    };
  }

  const receptionists = DEMO_RECEPTIONISTS.map((s) => makeStaff({ ...s, role: 'receptionist' }));
  const therapists = DEMO_THERAPISTS.map((s) => makeStaff({ ...s, role: 'therapist' }));
  state.staff = [...receptionists, ...therapists];

  state.availabilityPatterns = [];
  [...DEMO_RECEPTIONISTS.map((s, i) => [receptionists[i], s.days]), ...DEMO_THERAPISTS.map((s, i) => [therapists[i], s.days])]
    .forEach(([staffMember, days]) => {
      if (!days) return; // no pattern rows = available every day
      for (let dow = 0; dow < 7; dow++) {
        state.availabilityPatterns.push({ staffId: staffMember.id, dayOfWeek: dow, available: days.includes(dow) });
      }
    });

  state.openingHours = {
    defaultWeekday: { start: '10:30', end: '21:00' },
    defaultWeekend: { start: '08:30', end: '18:00' },
    overrides: [],
  };

  state.shiftTypeSets = [{
    id: newId(), effectiveFrom: '2020-01-01', effectiveTo: null,
    receptionShiftTypes: [
      { id: newId(), name: 'Morning', start: '10:30', end: '15:30', breakMinutes: 0 },
      { id: newId(), name: 'Late', start: '15:15', end: '21:00', breakMinutes: 30 },
      { id: newId(), name: 'Whole day', start: '10:30', end: '21:00', breakMinutes: 60 },
      { id: newId(), name: 'Weekend full day', start: '08:30', end: '18:00', breakMinutes: 60 },
    ],
    therapistShiftTypes: [
      { id: newId(), name: 'Weekday', start: '11:00', end: '20:00', breakMinutes: 60 },
      { id: newId(), name: 'Weekend', start: '09:00', end: '17:00', breakMinutes: 30 },
    ],
  }];

  state.weeklyHourCapSetting = { defaultCapHours: 39 };
  state.fairnessDimensions = [
    { code: 'REC_HOURS', role: 'receptionist', description: 'Overall reception hours worked', unit: 'hours' },
    { code: 'REC_WEEKEND', role: 'receptionist', description: 'Weekend reception hours worked', unit: 'hours' },
    { code: 'THER_HOURS', role: 'therapist', description: 'Overall therapist hours worked', unit: 'hours' },
  ];

  // Previous, current and next calendar month, so there's banked history,
  // a live "this week", and an upcoming schedule to show off in one demo.
  const weekStartSet = new Set();
  for (const delta of [-1, 0, 1]) {
    const { year, month } = shiftMonth(today, delta);
    for (const ws of weekStartsForMonth(year, month)) weekStartSet.add(ws);
  }
  const weekStarts = [...weekStartSet].sort();

  const allDates = new Set();
  for (const ws of weekStarts) {
    const d = new Date(`${ws}T00:00:00Z`);
    for (let i = 0; i < 7; i++) {
      const day = new Date(d);
      day.setUTCDate(d.getUTCDate() + i);
      allDates.add(isoDate(day));
    }
  }
  state.demand = [...allDates].map((date) => ({
    date, forecastHours: isoWeekday(date) >= 5 ? 8 : 12, overrideHours: null,
  }));

  const eligibility = buildEligibility(state);
  const result = solveChainedWeeks({
    weekStarts,
    openingHours: state.openingHours,
    shiftTypeSets: state.shiftTypeSets,
    receptionists,
    therapists,
    eligibility,
    weeklyHourCapSetting: state.weeklyHourCapSetting,
    demand: state.demand,
    ledgerEvents: state.ledgerEvents,
    isExempt: () => false,
  });

  const saved = saveChainedWeeksAsDraftPeriods(
    { rotaPeriods: state.rotaPeriods, shifts: state.shifts, assignments: state.assignments },
    result, newId, new Date().toISOString(),
  );
  state.rotaPeriods = saved.rotaPeriods;
  state.shifts = saved.shifts;
  state.assignments = saved.assignments;

  // Bank every week that's already fully in the past, so the ledger and
  // fairness balances have real history to show, not just a blank slate.
  const pastPeriods = state.rotaPeriods.filter((p) => p.endDate < today).sort((a, b) => a.startDate.localeCompare(b.startDate));
  for (const period of pastPeriods) {
    const closed = closePeriod(state, period.id, newId, new Date().toISOString());
    state.rotaPeriods = closed.rotaPeriods;
    state.assignments = closed.assignments;
    state.ledgerEvents = closed.ledgerEvents;
  }

  return state;
}

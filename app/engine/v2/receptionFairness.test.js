import { test } from 'node:test';
import assert from 'node:assert/strict';
import { referenceCostForDay, buildReceptionEntitlement, scoreReceptionFairnessState } from './receptionFairness.js';

const MORNING = { id: 'm', name: 'Morning', start: '10:30', end: '15:30', breakMinutes: 0 }; // 5h paid
const LATE = { id: 'l', name: 'Late', start: '15:15', end: '21:00', breakMinutes: 30 }; // 5.25h paid
const WHOLE_DAY = { id: 'w', name: 'Whole day', start: '10:30', end: '21:00', breakMinutes: 60 }; // 9.5h paid

test('referenceCostForDay: uses the cheapest valid combo, not whichever is listed first', () => {
  const day = { closed: false, combos: [[MORNING, LATE], [WHOLE_DAY]] }; // split totals 10.25h, whole-day 9.5h
  assert.equal(referenceCostForDay(day), 9.5);
});

test('referenceCostForDay: a closed day costs nothing', () => {
  assert.equal(referenceCostForDay({ closed: true, combos: [] }), 0);
});

test('buildReceptionEntitlement: splits each day\'s reference cost equally among that day\'s eligible people', () => {
  const dayContexts = [
    { date: '2026-08-03', closed: false, isWeekend: false, combos: [[WHOLE_DAY]] }, // cost 9.5h
  ];
  const receptionists = [{ id: 1 }, { id: 2 }];
  const eligibility = { isEligible: () => true };
  const entitlement = buildReceptionEntitlement(dayContexts, receptionists, eligibility);
  assert.equal(entitlement[1].REC_HOURS, 4.75);
  assert.equal(entitlement[2].REC_HOURS, 4.75);
});

test('buildReceptionEntitlement: no priorityWeight set on anyone is the same as an equal split (neutral default)', () => {
  const dayContexts = [{ date: '2026-08-03', closed: false, isWeekend: false, combos: [[WHOLE_DAY]] }];
  const receptionists = [{ id: 1, priorityWeight: 1.0 }, { id: 2, priorityWeight: 1.0 }];
  const eligibility = { isEligible: () => true };
  const entitlement = buildReceptionEntitlement(dayContexts, receptionists, eligibility);
  assert.equal(entitlement[1].REC_HOURS, 4.75);
  assert.equal(entitlement[2].REC_HOURS, 4.75);
});

test('buildReceptionEntitlement: a priorityWeight of 2.0 gives someone roughly double a neutral colleague\'s share', () => {
  const dayContexts = [{ date: '2026-08-03', closed: false, isWeekend: false, combos: [[WHOLE_DAY]] }]; // cost 9.5h
  const receptionists = [{ id: 1, priorityWeight: 2.0 }, { id: 2, priorityWeight: 1.0 }];
  const eligibility = { isEligible: () => true };
  const entitlement = buildReceptionEntitlement(dayContexts, receptionists, eligibility);
  // total weight 3, person 1 gets 2/3, person 2 gets 1/3
  assert.ok(Math.abs(entitlement[1].REC_HOURS - 9.5 * (2 / 3)) < 1e-9);
  assert.ok(Math.abs(entitlement[2].REC_HOURS - 9.5 * (1 / 3)) < 1e-9);
});

test('buildReceptionEntitlement: someone ineligible that day gets no share of it', () => {
  const dayContexts = [{ date: '2026-08-03', closed: false, isWeekend: false, combos: [[WHOLE_DAY]] }];
  const receptionists = [{ id: 1 }, { id: 2 }];
  const eligibility = { isEligible: (id) => id === 1 };
  const entitlement = buildReceptionEntitlement(dayContexts, receptionists, eligibility);
  assert.equal(entitlement[1].REC_HOURS, 9.5);
  assert.equal(entitlement[2].REC_HOURS, 0);
});

test('buildReceptionEntitlement: only weekend days contribute to REC_WEEKEND', () => {
  const dayContexts = [
    { date: '2026-08-03', closed: false, isWeekend: false, combos: [[WHOLE_DAY]] },
    { date: '2026-08-08', closed: false, isWeekend: true, combos: [[WHOLE_DAY]] },
  ];
  const receptionists = [{ id: 1 }];
  const eligibility = { isEligible: () => true };
  const entitlement = buildReceptionEntitlement(dayContexts, receptionists, eligibility);
  assert.equal(entitlement[1].REC_HOURS, 19); // both days
  assert.equal(entitlement[1].REC_WEEKEND, 9.5); // only the weekend day
});

test('buildReceptionEntitlement: closed days contribute nothing to anyone', () => {
  const dayContexts = [{ date: '2026-08-06', closed: true, isWeekend: false, combos: [] }];
  const receptionists = [{ id: 1 }];
  const eligibility = { isEligible: () => true };
  const entitlement = buildReceptionEntitlement(dayContexts, receptionists, eligibility);
  assert.equal(entitlement[1].REC_HOURS, 0);
});

test('scoreReceptionFairnessState: zero deviation when actual hours exactly match entitlement and there is no existing balance', () => {
  const receptionists = [{ id: 1 }];
  const entitlement = { 1: { REC_HOURS: 9.5, REC_WEEKEND: 0 } };
  const score = scoreReceptionFairnessState(
    receptionists, entitlement, () => 0, () => false, { 1: { paidHoursSoFar: 9.5, weekendPaidHoursSoFar: 0 } }
  );
  assert.equal(score.total, 0);
});

test('scoreReceptionFairnessState: an existing ledger balance carries forward into the deviation', () => {
  const receptionists = [{ id: 1 }];
  const entitlement = { 1: { REC_HOURS: 0, REC_WEEKEND: 0 } };
  const existingBalance = (id, dim) => (dim === 'REC_HOURS' ? -3 : 0); // already owed 3h
  const score = scoreReceptionFairnessState(
    receptionists, entitlement, existingBalance, () => false, { 1: { paidHoursSoFar: 0, weekendPaidHoursSoFar: 0 } }
  );
  assert.equal(score.total, 3);
});

test('scoreReceptionFairnessState: an exempt dimension is excluded from the total', () => {
  const receptionists = [{ id: 1 }];
  const entitlement = { 1: { REC_HOURS: 0, REC_WEEKEND: 10 } };
  const isExempt = (id, dim) => dim === 'REC_WEEKEND';
  const score = scoreReceptionFairnessState(
    receptionists, entitlement, () => 0, isExempt, { 1: { paidHoursSoFar: 0, weekendPaidHoursSoFar: 0 } }
  );
  assert.equal(score.total, 0); // would be 10 if REC_WEEKEND weren't exempt
});

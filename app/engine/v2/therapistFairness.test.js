import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demandForDay, buildTherapistEntitlement, scoreTherapistFairnessState } from './therapistFairness.js';

test('demandForDay: uses overrideHours when set, even if it is falsy-but-defined-looking (zero)', () => {
  const demand = [{ date: '2026-08-03', forecastHours: 20, overrideHours: 0 }];
  assert.equal(demandForDay(demand, '2026-08-03'), 0);
});

test('demandForDay: falls back to forecastHours when overrideHours is null', () => {
  const demand = [{ date: '2026-08-03', forecastHours: 20, overrideHours: null }];
  assert.equal(demandForDay(demand, '2026-08-03'), 20);
});

test('demandForDay: a date with no entry at all has zero demand', () => {
  assert.equal(demandForDay([], '2026-08-03'), 0);
});

test('buildTherapistEntitlement: splits raw demand proportionally to contracted fraction among the eligible pool', () => {
  const dayContexts = [{ date: '2026-08-03', closed: false, isWeekend: false, demandHours: 15 }];
  const therapists = [
    { id: 1, proportionalFraction: 1.0 },
    { id: 2, proportionalFraction: 0.5 },
  ];
  const eligibility = { isEligible: () => true };
  const entitlement = buildTherapistEntitlement(dayContexts, therapists, eligibility);
  // total fraction 1.5 -> person 1 gets 1/1.5 of demand, person 2 gets 0.5/1.5
  assert.ok(Math.abs(entitlement[1].THER_HOURS - 15 * (1 / 1.5)) < 1e-9);
  assert.ok(Math.abs(entitlement[2].THER_HOURS - 15 * (0.5 / 1.5)) < 1e-9);
});

test('buildTherapistEntitlement: a closed day or a zero-demand day contributes nothing to anyone', () => {
  const therapists = [{ id: 1, proportionalFraction: 1.0 }];
  const eligibility = { isEligible: () => true };
  const closedDay = buildTherapistEntitlement([{ date: '2026-08-06', closed: true, isWeekend: false, demandHours: 0 }], therapists, eligibility);
  assert.equal(closedDay[1].THER_HOURS, 0);
  const zeroDemandDay = buildTherapistEntitlement([{ date: '2026-08-03', closed: false, isWeekend: false, demandHours: 0 }], therapists, eligibility);
  assert.equal(zeroDemandDay[1].THER_HOURS, 0);
});

test('buildTherapistEntitlement: someone ineligible that day gets no share, and it is not redistributed away from the raw total incorrectly', () => {
  const dayContexts = [{ date: '2026-08-03', closed: false, isWeekend: false, demandHours: 20 }];
  const therapists = [{ id: 1, proportionalFraction: 1.0 }, { id: 2, proportionalFraction: 1.0 }];
  const eligibility = { isEligible: (id) => id === 1 };
  const entitlement = buildTherapistEntitlement(dayContexts, therapists, eligibility);
  assert.equal(entitlement[1].THER_HOURS, 20); // sole eligible person gets the full raw demand
  assert.equal(entitlement[2].THER_HOURS, 0);
});

test('buildTherapistEntitlement: no priorityWeight set on anyone is the same as fraction-only splitting (neutral default)', () => {
  const dayContexts = [{ date: '2026-08-03', closed: false, isWeekend: false, demandHours: 15 }];
  const therapists = [{ id: 1, proportionalFraction: 1.0, priorityWeight: 1.0 }, { id: 2, proportionalFraction: 1.0, priorityWeight: 1.0 }];
  const eligibility = { isEligible: () => true };
  const entitlement = buildTherapistEntitlement(dayContexts, therapists, eligibility);
  assert.equal(entitlement[1].THER_HOURS, 7.5);
  assert.equal(entitlement[2].THER_HOURS, 7.5);
});

test('buildTherapistEntitlement: a priorityWeight of 2.0 gives someone roughly double a neutral colleague\'s share, even with equal contracted fractions', () => {
  const dayContexts = [{ date: '2026-08-03', closed: false, isWeekend: false, demandHours: 15 }];
  const therapists = [
    { id: 1, proportionalFraction: 1.0, priorityWeight: 2.0 },
    { id: 2, proportionalFraction: 1.0, priorityWeight: 1.0 },
  ];
  const eligibility = { isEligible: () => true };
  const entitlement = buildTherapistEntitlement(dayContexts, therapists, eligibility);
  assert.ok(Math.abs(entitlement[1].THER_HOURS - 15 * (2 / 3)) < 1e-9);
  assert.ok(Math.abs(entitlement[2].THER_HOURS - 15 * (1 / 3)) < 1e-9);
});

test('buildTherapistEntitlement: priorityWeight and contracted fraction combine multiplicatively, not independently', () => {
  const dayContexts = [{ date: '2026-08-03', closed: false, isWeekend: false, demandHours: 20 }];
  const therapists = [
    { id: 1, proportionalFraction: 0.5, priorityWeight: 2.0 }, // effective weight 1.0
    { id: 2, proportionalFraction: 1.0, priorityWeight: 1.0 }, // effective weight 1.0
  ];
  const eligibility = { isEligible: () => true };
  const entitlement = buildTherapistEntitlement(dayContexts, therapists, eligibility);
  // equal effective weight (1.0 each) -> equal split, despite very different fraction/weight inputs
  assert.ok(Math.abs(entitlement[1].THER_HOURS - 10) < 1e-9);
  assert.ok(Math.abs(entitlement[2].THER_HOURS - 10) < 1e-9);
});

test('scoreTherapistFairnessState: zero deviation when actual hours exactly match entitlement and there is no existing balance', () => {
  const therapists = [{ id: 1 }];
  const entitlement = { 1: { THER_HOURS: 20 } };
  const score = scoreTherapistFairnessState(therapists, entitlement, () => 0, () => false, { 1: { paidHoursSoFar: 20 } });
  assert.equal(score.total, 0);
});

test('scoreTherapistFairnessState: an existing ledger balance carries forward into the deviation', () => {
  const therapists = [{ id: 1 }];
  const entitlement = { 1: { THER_HOURS: 20 } };
  const existingBalance = () => -5; // already 5h behind
  const score = scoreTherapistFairnessState(therapists, entitlement, existingBalance, () => false, { 1: { paidHoursSoFar: 20 } });
  assert.equal(score.total, 5);
  assert.equal(score.perPerson[1], -5);
});

test('scoreTherapistFairnessState: an exempt person is excluded from the total and from perPerson', () => {
  const therapists = [{ id: 1 }, { id: 2 }];
  const entitlement = { 1: { THER_HOURS: 0 }, 2: { THER_HOURS: 0 } };
  const isExempt = (id) => id === 1;
  const score = scoreTherapistFairnessState(
    therapists, entitlement, () => 0, isExempt, { 1: { paidHoursSoFar: 10 }, 2: { paidHoursSoFar: 0 } }
  );
  assert.equal(score.total, 0); // would be 10 if person 1 weren't exempt
  assert.equal(score.perPerson[1], undefined);
});

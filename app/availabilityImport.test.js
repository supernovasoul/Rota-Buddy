import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildParsePrompt, buildChatFallbackPrompt, extractJson, validateParsedAvailability, applyAvailabilityImport,
} from './availabilityImport.js';

const STAFF = [
  { id: 's1', name: 'AnnaKay', role: 'receptionist' },
  { id: 's2', name: 'Jo', role: 'receptionist' },
  { id: 't1', name: 'Mia', role: 'therapist' },
];
let counter = 0;
const newId = () => `id${++counter}`;

test('buildParsePrompt: includes roster, weekday-labelled calendar and the pasted text', () => {
  const prompt = buildParsePrompt({ staff: STAFF, year: 2026, month: 8, text: 'Jo: 7 Aug early' });
  assert.match(prompt, /AnnaKay \(receptionist\)/);
  assert.match(prompt, /2026-08-07 Fri/);
  assert.match(prompt, /2026-08-31 Mon/);
  assert.match(prompt, /Jo: 7 Aug early/);
});

test('buildChatFallbackPrompt: asks for JSON matching the schema', () => {
  const prompt = buildChatFallbackPrompt({ staff: STAFF, year: 2026, month: 8, text: 'x' });
  assert.match(prompt, /Reply with ONLY a JSON object/);
  assert.match(prompt, /"unmentionedDays"/);
});

test('extractJson: handles code fences and surrounding chatter', () => {
  assert.deepEqual(extractJson('Here you go:\n```json\n{"people":[]}\n```\nThanks'), { people: [] });
  assert.deepEqual(extractJson('Sure! {"people":[],"unrecognisedText":[]} hope that helps'), { people: [], unrecognisedText: [] });
  assert.throws(() => extractJson('no json here'), /JSON/);
});

test('validateParsedAvailability: matches names loosely and drops unknown people and out-of-month dates', () => {
  const { people, problems } = validateParsedAvailability({
    people: [
      { staffName: 'annakay', unmentionedDays: 'unavailable', notes: [], days: [
        { date: '2026-08-04', status: 'available', slots: ['early'], note: '' },
        { date: '2026-09-01', status: 'available', slots: [], note: '' },
      ] },
      { staffName: 'Ol', unmentionedDays: 'unavailable', notes: [], days: [] },
    ],
    unrecognisedText: [],
  }, STAFF, 2026, 8);
  assert.equal(people.length, 1);
  assert.equal(people[0].staffId, 's1');
  assert.deepEqual(people[0].days.map((d) => d.date), ['2026-08-04']);
  assert.equal(problems.length, 2);
});

test('validateParsedAvailability: weekend half-shift offers become unavailable with a problem; all three slots collapse to "any"', () => {
  const { people, problems } = validateParsedAvailability({
    people: [{ staffName: 'Jo', unmentionedDays: 'unavailable', notes: [], days: [
      { date: '2026-08-08', status: 'available', slots: ['later'], note: '' }, // Saturday
      { date: '2026-08-10', status: 'available', slots: ['full', 'early', 'later'], note: 'all day' },
    ] }],
    unrecognisedText: [],
  }, STAFF, 2026, 8);
  assert.equal(people[0].days[0].status, 'unavailable');
  assert.match(problems[0], /weekend/);
  assert.deepEqual(people[0].days[1].slots, []);
});

test('validateParsedAvailability: therapists never get slots', () => {
  const { people } = validateParsedAvailability({
    people: [{ staffName: 'Mia', unmentionedDays: 'pattern', notes: [], days: [{ date: '2026-08-04', status: 'available', slots: ['early'], note: '' }] }],
    unrecognisedText: [],
  }, STAFF, 2026, 8);
  assert.deepEqual(people[0].days[0].slots, []);
});

test('applyAvailabilityImport: writes stated days with slots, fills unmentioned days, and replaces earlier overrides in that month only', () => {
  const existing = [
    { id: 'old1', staffId: 's1', dateFrom: '2026-08-04', dateTo: '2026-08-04', type: 'holiday', note: '' },
    { id: 'old2', staffId: 's1', dateFrom: '2026-07-30', dateTo: '2026-08-02', type: 'holiday', note: '' }, // straddles month start
    { id: 'keep', staffId: 's2', dateFrom: '2026-08-04', dateTo: '2026-08-04', type: 'sick', note: '' }, // not imported
  ];
  const imported = [{ staffId: 's1', staffName: 'AnnaKay', unmentionedDays: 'unavailable', notes: [], days: [
    { date: '2026-08-04', status: 'available', slots: ['early'], note: '' },
    { date: '2026-08-05', status: 'available', slots: [], note: '' },
  ] }];
  const result = applyAvailabilityImport(existing, imported, 2026, 8, newId);
  const s1Aug = result.filter((a) => a.staffId === 's1' && a.dateFrom >= '2026-08-01');
  assert.equal(s1Aug.length, 31, 'one override per day of August');
  const aug4 = s1Aug.find((a) => a.dateFrom === '2026-08-04');
  assert.equal(aug4.type, 'available');
  assert.deepEqual(aug4.shiftSlots, ['early']);
  assert.equal(s1Aug.find((a) => a.dateFrom === '2026-08-05').shiftSlots, undefined);
  assert.equal(s1Aug.find((a) => a.dateFrom === '2026-08-06').type, 'unavailable');
  assert.ok(result.some((a) => a.id === 'keep'));
  const trimmed = result.find((a) => a.staffId === 's1' && a.dateFrom === '2026-07-30');
  assert.equal(trimmed.dateTo, '2026-07-31', 'July part of a straddling range survives');
});

test('applyAvailabilityImport: "pattern" leaves unmentioned days following the weekly pattern', () => {
  const result = applyAvailabilityImport([], [{ staffId: 's2', staffName: 'Jo', unmentionedDays: 'pattern', notes: [], days: [
    { date: '2026-08-17', status: 'unavailable', slots: [], note: 'spa training' },
  ] }], 2026, 8, newId);
  assert.equal(result.length, 1);
  assert.equal(result[0].note, 'spa training');
});

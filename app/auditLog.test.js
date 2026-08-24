import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendAuditLog, sortedAuditLogDesc } from './auditLog.js';

let idCounter = 0;
function newId() { return `id-${idCounter++}`; }

test('appendAuditLog: builds the correct shape from injected newId/timestamp', () => {
  const result = appendAuditLog([], newId, '2026-07-25T10:00:00Z', {
    type: 'manual_override', staffId: 's1', shiftId: 'sh1', before: { staffId: 's0' }, after: { staffId: 's1' }, note: 'Swapped staff on this shift',
  });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    id: 'id-0', timestamp: '2026-07-25T10:00:00Z', type: 'manual_override',
    staffId: 's1', shiftId: 'sh1', before: { staffId: 's0' }, after: { staffId: 's1' }, note: 'Swapped staff on this shift',
  });
});

test('appendAuditLog: defaults before/after/note when omitted', () => {
  const result = appendAuditLog([], newId, '2026-07-25T10:00:00Z', { type: 'cancellation', staffId: 's1', shiftId: 'sh1' });
  assert.equal(result[0].before, null);
  assert.equal(result[0].after, null);
  assert.equal(result[0].note, '');
});

test('appendAuditLog: preserves prior entries and does not mutate the input array', () => {
  const existing = [{ id: 'a0', timestamp: 't0', type: 'manual_override', staffId: 's0', shiftId: 'sh0', before: null, after: null, note: '' }];
  const result = appendAuditLog(existing, newId, '2026-07-25T10:00:00Z', { type: 'cancellation', staffId: 's1', shiftId: 'sh1' });
  assert.equal(existing.length, 1, 'input array must not be mutated');
  assert.equal(result.length, 2);
  assert.equal(result[0], existing[0]);
});

test('sortedAuditLogDesc: orders newest-first without mutating the input', () => {
  const entries = [
    { id: 'a', timestamp: '2026-07-20T00:00:00Z' },
    { id: 'b', timestamp: '2026-07-25T00:00:00Z' },
    { id: 'c', timestamp: '2026-07-22T00:00:00Z' },
  ];
  const sorted = sortedAuditLogDesc(entries);
  assert.deepEqual(sorted.map((e) => e.id), ['b', 'c', 'a']);
  assert.deepEqual(entries.map((e) => e.id), ['a', 'b', 'c'], 'input array order must be untouched');
});

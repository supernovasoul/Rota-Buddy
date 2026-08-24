import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateAvailabilityRequestMessage } from './availabilityMessage.js';

test('generateAvailabilityRequestMessage: greets the person by name', () => {
  const message = generateAvailabilityRequestMessage({ name: 'Amira Khan' }, 2026, 8);
  assert.ok(message.startsWith('Hi Amira Khan,'));
});

test('generateAvailabilityRequestMessage: includes a plain-English month and year, not a numeric date', () => {
  const message = generateAvailabilityRequestMessage({ name: 'Dev Patel' }, 2026, 12);
  assert.ok(message.includes('December 2026'));
});

test('generateAvailabilityRequestMessage: never asks for a filled-in form - just a reply', () => {
  const message = generateAvailabilityRequestMessage({ name: 'Amira Khan' }, 2026, 8);
  assert.ok(message.toLowerCase().includes('reply'));
  assert.ok(!message.toLowerCase().includes('attach'));
});

// Vercel serverless function: reads pasted staff availability messages
// with Claude and returns structured JSON (see app/availabilityImport.js
// for the prompt and schema, which the browser's free copy/paste
// fallback shares). The API key never reaches the browser; a shared
// passcode (ROTA_PASSCODE) stops strangers on the public demo URL from
// spending it.

import Anthropic from '@anthropic-ai/sdk';
import { timingSafeEqual } from 'node:crypto';
import { buildParsePrompt, PARSED_AVAILABILITY_SCHEMA, MAX_PASTE_CHARS } from '../app/availabilityImport.js';

export const config = { maxDuration: 60 };

function passcodeOk(given) {
  const expected = process.env.ROTA_PASSCODE;
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.ANTHROPIC_API_KEY || !process.env.ROTA_PASSCODE) {
    return res.status(503).json({ error: 'AI reading is not set up on this deployment - use the copy/paste option instead.' });
  }

  const { passcode, text, staff, year, month } = req.body ?? {};
  if (!passcodeOk(passcode)) return res.status(401).json({ error: 'Wrong passcode.' });
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Paste some availability text first.' });
  if (text.length > MAX_PASTE_CHARS) return res.status(400).json({ error: `That's too long - paste under ${MAX_PASTE_CHARS} characters at a time.` });
  if (!Array.isArray(staff) || staff.length === 0 || staff.length > 200 || !Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: 'Missing staff list or month.' });
  }
  const roster = staff.map((s) => ({ name: String(s.name).slice(0, 80), role: s.role === 'therapist' ? 'therapist' : 'receptionist' }));

  try {
    const client = new Anthropic(); // reads ANTHROPIC_API_KEY
    const response = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: PARSED_AVAILABILITY_SCHEMA },
      },
      messages: [{ role: 'user', content: buildParsePrompt({ staff: roster, year, month, text }) }],
    });

    if (response.stop_reason === 'refusal') {
      return res.status(422).json({ error: 'Claude declined to read that text - try the copy/paste option.' });
    }
    if (response.stop_reason === 'max_tokens') {
      return res.status(422).json({ error: 'That was too much to read in one go - paste fewer people at a time.' });
    }
    const textBlock = response.content.find((b) => b.type === 'text');
    return res.status(200).json({ parsed: JSON.parse(textBlock.text) });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: 'Busy right now - try again in a minute.' });
    if (err instanceof Anthropic.APIError) {
      console.error('Anthropic API error', err.status, err.message);
      return res.status(502).json({ error: 'The AI service returned an error - try again, or use the copy/paste option.' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong reading that text.' });
  }
}

// "Paste availability" - turns the free-text replies staff send back
// (e.g. "9 Aug late, maybe all day", "Tuesdays and Thursdays, early or
// late") into one-off availability[] overrides. Claude does the reading
// (either via /api/parse-availability, or - the free fallback - the
// manager pastes buildParsePrompt's output into a Claude chat and pastes
// the JSON reply back). Everything here is pure and unit tested: the
// prompt, the output schema, and the validation that stands between
// whatever the model returned and what actually gets written to state.
// The model only ever proposes; validateParsedAvailability decides what's
// usable, and the manager confirms a preview before anything is applied.

import { datesInMonth } from './availability.js';
import { isoWeekday } from './engine/eligibility.js';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export const SLOTS = ['early', 'later', 'full'];
export const MAX_PASTE_CHARS = 20000;

// JSON schema for structured output - also the shape the fallback prompt
// asks a chat to reply with, so both paths share one validator.
export const PARSED_AVAILABILITY_SCHEMA = {
  type: 'object',
  properties: {
    people: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          staffName: { type: 'string' },
          unmentionedDays: { type: 'string', enum: ['unavailable', 'available', 'pattern'] },
          days: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                date: { type: 'string' },
                status: { type: 'string', enum: ['available', 'unavailable'] },
                slots: { type: 'array', items: { type: 'string', enum: SLOTS } },
                note: { type: 'string' },
              },
              required: ['date', 'status', 'slots', 'note'],
              additionalProperties: false,
            },
          },
          notes: { type: 'array', items: { type: 'string' } },
        },
        required: ['staffName', 'unmentionedDays', 'days', 'notes'],
        additionalProperties: false,
      },
    },
    unrecognisedText: { type: 'array', items: { type: 'string' } },
  },
  required: ['people', 'unrecognisedText'],
  additionalProperties: false,
};

function calendarLines(year, month) {
  return datesInMonth(year, month).map((d) => `${d} ${DAY_NAMES[isoWeekday(d)]}`).join('\n');
}

// One prompt for both paths. Staff names and the month calendar are
// included so the model never has to guess which weekday a date is or
// invent a person who isn't on the team.
export function buildParsePrompt({ staff, year, month, text }) {
  const roster = staff.map((s) => `- ${s.name} (${s.role})`).join('\n');
  return `You are reading staff availability messages for a spa's ${MONTH_NAMES[month - 1]} ${year} rota and converting them to structured data.

<team>
${roster}
</team>

<calendar>
${calendarLines(year, month)}
</calendar>

<shift_slots>
- "early": weekday morning half-shift (roughly 10:30-15:30)
- "later": weekday evening half-shift (roughly 15:30-21:00)
- "full": a whole-day shift. Weekends (Sat/Sun) only have "full" shifts.
</shift_slots>

<messages>
${text}
</messages>

Instructions:
- Make one entry in "people" per team member the messages mention. Use the exact name from <team>; match nicknames, initials and case loosely (e.g. "AK" or "Annakay" -> "AnnaKay").
- Expand recurring statements ("Tuesdays and Thursdays", "every weekend", "4th-8th") into individual dates from <calendar>. Only use dates in <calendar>.
- For each date they can work: status "available" and "slots" listing what they offered. "early" -> ["early"]; "late"/"evening" -> ["later"]; "all day"/"full day" -> ["full", "early", "later"]; "any"/"anything"/just the date with no shift given -> []. Empty slots means any shift.
- For dates they say they can't work (holiday, training, appointments): status "unavailable", slots [].
- On a Sat/Sun, a person who offers any shift at all is available for "full" (the only weekend shift) - use ["full"] unless they say they can't do a full day there, in which case mark it unavailable and say why in note.
- Keep hedges and preferences in "note" (e.g. "maybe all day", "prefers full day"), and still pick the slots they definitely offered.
- "unmentionedDays": "unavailable" if they listed the days they CAN work (the usual case); "available" if they listed only days they CAN'T work or said blank days are fine; "pattern" if they gave no month-specific information.
- Put limits the data can't express (e.g. "max 4 shifts", "no more than 20 hours") in that person's "notes".
- Put any message text that mentions someone not in <team>, or that you could not interpret, in "unrecognisedText", quoted.
- Never invent availability that wasn't stated.`;
}

// The fallback path: same prompt, plus an explicit "reply with only JSON"
// instruction, since a chat has no structured-output guarantee.
export function buildChatFallbackPrompt(args) {
  return `${buildParsePrompt(args)}

Reply with ONLY a JSON object (no commentary, no code fences) matching this JSON schema:
${JSON.stringify(PARSED_AVAILABILITY_SCHEMA)}`;
}

// Accepts a pasted chat reply that may still be wrapped in ```json fences
// or have a sentence before/after it.
export function extractJson(replyText) {
  const trimmed = replyText.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1);
  if (!candidate) throw new Error('No JSON object found in the pasted reply.');
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error("Couldn't read the pasted reply as JSON - copy Claude's whole answer and try again.");
  }
}

function normaliseName(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Turns whatever the model returned into rows the app can safely apply,
// plus human-readable problems for anything it had to drop. Never throws
// on bad entries - a single odd line shouldn't sink the whole paste.
export function validateParsedAvailability(parsed, staff, year, month) {
  const problems = [];
  const people = [];
  const monthDates = new Set(datesInMonth(year, month));
  const byName = new Map(staff.map((s) => [normaliseName(s.name), s]));

  if (!parsed || !Array.isArray(parsed.people)) {
    return { people, problems: ['The reply had no "people" list.'], unrecognisedText: [] };
  }

  for (const person of parsed.people) {
    const member = byName.get(normaliseName(person.staffName));
    if (!member) {
      problems.push(`"${person.staffName}" isn't on the team - skipped.`);
      continue;
    }
    const unmentionedDays = ['unavailable', 'available', 'pattern'].includes(person.unmentionedDays) ? person.unmentionedDays : 'pattern';
    const days = new Map(); // date -> row; later duplicates win
    for (const day of person.days ?? []) {
      if (!monthDates.has(day.date)) {
        problems.push(`${member.name}: ${day.date} isn't in this month - skipped.`);
        continue;
      }
      const status = day.status === 'unavailable' ? 'unavailable' : 'available';
      let slots = [...new Set((day.slots ?? []).filter((s) => SLOTS.includes(s)))];
      const weekend = isoWeekday(day.date) >= 5;
      if (status === 'available' && weekend && slots.length > 0 && !slots.includes('full')) {
        problems.push(`${member.name}: ${day.date} is a weekend (full-day shifts only) but they only offered ${slots.join('/')} - left as unavailable.`);
        days.set(day.date, { date: day.date, status: 'unavailable', slots: [], note: day.note ?? '' });
        continue;
      }
      if (weekend) slots = slots.filter((s) => s === 'full');
      // therapists' availability is day-level only - slots don't apply
      if (member.role !== 'receptionist') slots = [];
      // all three slots ticked is the same as "any" - store it that way
      if (slots.length === SLOTS.length) slots = [];
      days.set(day.date, { date: day.date, status, slots, note: String(day.note ?? '') });
    }
    people.push({
      staffId: member.id,
      staffName: member.name,
      unmentionedDays,
      days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
      notes: (person.notes ?? []).map(String),
    });
  }

  return { people, problems, unrecognisedText: (parsed.unrecognisedText ?? []).map(String) };
}

// Writes a validated import into availability[]: every date in the month
// for each imported person is replaced (so re-importing a corrected
// message is safe), using single-day overrides like the paint grid does.
// Dates not mentioned follow that person's unmentionedDays choice;
// 'pattern' clears them back to the weekly pattern.
export function applyAvailabilityImport(availability, importedPeople, year, month, newId) {
  const monthDates = datesInMonth(year, month);
  const first = monthDates[0];
  const last = monthDates[monthDates.length - 1];
  const importedIds = new Set(importedPeople.map((p) => p.staffId));

  // drop every override these people have that sits inside this month
  // (single-day ones are removed; a range overlapping the month is kept
  // only for the dates outside it - rare, but don't silently lose them)
  let result = [];
  for (const a of availability) {
    if (!importedIds.has(a.staffId) || a.dateTo < first || a.dateFrom > last) {
      result.push(a);
      continue;
    }
    if (a.dateFrom < first) result.push({ ...a, id: newId(), dateTo: dayBefore(first) });
    if (a.dateTo > last) result.push({ ...a, id: newId(), dateFrom: dayAfter(last) });
  }

  for (const person of importedPeople) {
    const stated = new Map(person.days.map((d) => [d.date, d]));
    for (const date of monthDates) {
      const day = stated.get(date);
      if (day) {
        const row = { id: newId(), staffId: person.staffId, dateFrom: date, dateTo: date, type: day.status, note: day.note };
        if (day.status === 'available' && day.slots.length > 0) row.shiftSlots = day.slots;
        result.push(row);
      } else if (person.unmentionedDays !== 'pattern') {
        result.push({ id: newId(), staffId: person.staffId, dateFrom: date, dateTo: date, type: person.unmentionedDays, note: '' });
      }
    }
  }
  return result;
}

function shiftDay(dateIso, delta) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function dayBefore(dateIso) { return shiftDay(dateIso, -1); }
function dayAfter(dateIso) { return shiftDay(dateIso, 1); }

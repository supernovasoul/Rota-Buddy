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
// asks a chat to reply with, so both paths share one validator. The
// specialShifts enum is the names of this spa's "only if offered" shift
// types, so the model can only ever name one that really exists.
export function parsedAvailabilitySchema(specialShiftNames = []) {
  return {
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
                  specialShifts: specialShiftNames.length
                    ? { type: 'array', items: { type: 'string', enum: specialShiftNames } }
                    : { type: 'array', items: { type: 'string' }, maxItems: 0 },
                  note: { type: 'string' },
                },
                required: ['date', 'status', 'slots', 'specialShifts', 'note'],
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
}

// The reception shift types that are only used when someone names them
// (see app/data-model.md) - what the prompt calls "special shifts".
export function specialShiftsFrom(receptionShiftTypes) {
  return (receptionShiftTypes ?? [])
    .filter((t) => t.onlyIfOffered)
    .map((t) => ({ id: t.id, name: t.name, start: t.start, end: t.end, daysOfWeek: t.daysOfWeek ?? null }));
}

function specialShiftLines(specialShifts) {
  if (!specialShifts.length) return '(none configured)';
  return specialShifts.map((t) => {
    const days = t.daysOfWeek ? t.daysOfWeek.map((d) => DAY_NAMES[d]).join('/') : 'any day';
    return `- "${t.name}": ${t.start}-${t.end}, ${days}`;
  }).join('\n');
}

function calendarLines(year, month) {
  return datesInMonth(year, month).map((d) => `${d} ${DAY_NAMES[isoWeekday(d)]}`).join('\n');
}

// One prompt for both paths. Staff names and the month calendar are
// included so the model never has to guess which weekday a date is or
// invent a person who isn't on the team.
export function buildParsePrompt({ staff, year, month, text, specialShifts = [] }) {
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
- "full": a whole-day shift. Weekends (Sat/Sun) normally only have "full" shifts.
</shift_slots>

<special_shifts>
${specialShiftLines(specialShifts)}
</special_shifts>

<messages>
${text}
</messages>

Instructions:
- Make one entry in "people" per team member the messages mention. Use the exact name from <team>; match nicknames, initials and case loosely (e.g. "AK" or "Annakay" -> "AnnaKay").
- Expand recurring statements ("Tuesdays and Thursdays", "every weekend", "4th-8th") into individual dates from <calendar>. Only use dates in <calendar>.
- For each date they can work: status "available" and "slots" listing what they offered. "early" -> ["early"]; "late"/"evening" -> ["later"]; "all day"/"full day" -> ["full", "early", "later"]; "any"/"anything"/just the date with no shift given -> []. Empty slots means any shift.
- For dates they say they can't work (holiday, training, appointments): status "unavailable", slots [].
- On a Sat/Sun, a person who offers any shift at all is available for "full" (the only weekend shift) - use ["full"] unless they say they can't do a full day there, in which case mark it unavailable and say why in note.
- Special shifts are only used when a message explicitly asks for one: its times (e.g. "10:30-4:15", "till 4.15", "from 4pm") or a half day on a day that has one (e.g. "Sat morning", "half day Saturday"). Put the matching name(s) in "specialShifts" for that date, only on days that special shift runs. If they offered only a special shift, leave "slots" empty; if they offered a standard shift as well, list it in "slots" too. A half day that doesn't say which half -> list both halves and say so in note. Otherwise "specialShifts" is [].
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
${JSON.stringify(parsedAvailabilitySchema((args.specialShifts ?? []).map((t) => t.name)))}`;
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
export function validateParsedAvailability(parsed, staff, year, month, specialShifts = []) {
  const specialByName = new Map(specialShifts.map((t) => [normaliseName(t.name), t]));
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
      const dow = isoWeekday(day.date);
      const weekend = dow >= 5;
      let slots = [...new Set((day.slots ?? []).filter((sl) => SLOTS.includes(sl)))];
      const specialIds = [];
      for (const name of status === 'available' && member.role === 'receptionist' ? (day.specialShifts ?? []) : []) {
        const special = specialByName.get(normaliseName(name));
        if (!special) {
          problems.push(`${member.name}: "${name}" on ${day.date} isn't a configured shift - ignored.`);
        } else if (special.daysOfWeek && !special.daysOfWeek.includes(dow)) {
          problems.push(`${member.name}: "${special.name}" doesn't run on ${DAY_NAMES[dow]} ${day.date} - ignored.`);
        } else if (!specialIds.includes(special.id)) {
          specialIds.push(special.id);
        }
      }
      // they asked only for special shift(s), none of which could be used
      // - don't let that fall through to an empty slots list ("any shift")
      if (status === 'available' && slots.length === 0 && (day.specialShifts ?? []).length > 0 && specialIds.length === 0 && member.role === 'receptionist') {
        days.set(day.date, { date: day.date, status: 'unavailable', slots: [], specialShiftIds: [], note: String(day.note ?? '') });
        continue;
      }
      if (weekend) slots = slots.filter((sl) => sl === 'full');
      if (status === 'available' && weekend && (day.slots ?? []).length > 0 && slots.length === 0 && specialIds.length === 0) {
        problems.push(`${member.name}: ${day.date} is a weekend (full-day shifts unless a half day is set up) but they only offered ${day.slots.join('/')} - left as unavailable.`);
        days.set(day.date, { date: day.date, status: 'unavailable', slots: [], specialShiftIds: [], note: day.note ?? '' });
        continue;
      }
      // therapists' availability is day-level only - slots don't apply
      if (member.role !== 'receptionist') slots = [];
      // all three slots ticked is the same as "any standard shift" - store
      // it that way, unless special shifts were offered too (then an empty
      // slots list would wrongly read as "special shifts only")
      if (slots.length === SLOTS.length && specialIds.length === 0) slots = [];
      days.set(day.date, { date: day.date, status, slots, specialShiftIds: specialIds, note: String(day.note ?? '') });
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
        if (day.status === 'available' && day.specialShiftIds?.length > 0) row.offeredShiftTypeIds = day.specialShiftIds;
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

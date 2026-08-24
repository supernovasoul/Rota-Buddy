// Rest-week nudge — a soft, manager-controlled risk-management signal,
// NOT a hard legal rule. It exists to flag when a flex/casual worker's
// rota is starting to look like a continuous, regular schedule (which
// can contribute to their being treated as having employee-like status
// regardless of contract terms), so a manager can choose to interrupt
// that pattern with a genuine no-shifts week. See the restWeekPolicyDefaults
// section of app/data-model.md for the full reasoning.
//
// This module NEVER excludes anyone from shifts itself — it only
// computes advisory data. The only thing that actually removes someone
// from a week's shifts for rest-week reasons is a plannedRestWeeks entry,
// which only ever exists because a manager put it there. Keep this
// separate from genuine hard rules (11h rest, WTR 48h) — those are
// enforced unconditionally elsewhere and have no "policy" to disable.

export function resolveRestWeekPolicy(staffMember, defaults) {
  if (staffMember.restWeekPolicyOverride) return staffMember.restWeekPolicyOverride;
  return defaults[staffMember.employmentType] ?? { enabled: false, minWeeks: null, maxWeeks: null };
}

// recentWeeks: [{ weekStart, staffIdsWithShifts: [id, ...] }], ordered
// oldest -> newest, covering the weeks immediately BEFORE the one being
// planned (not including it). A week counts as worked for a person if
// they appear in that week's staffIdsWithShifts at all - any amount of
// shifts, since partial weeks still show the "regular pattern" look this
// nudge is watching for. The streak counts backward from the most recent
// week and stops at the first week with no shifts for that person -
// ANY shift-free week (planned rest, holiday, low demand, whatever)
// resets it; the nudge never fires again for a gap that already happened.
export function weeksSinceLastBreak(staffId, recentWeeks) {
  let streak = 0;
  for (let i = recentWeeks.length - 1; i >= 0; i--) {
    const worked = recentWeeks[i].staffIdsWithShifts.includes(staffId);
    if (!worked) break;
    streak++;
  }
  return streak;
}

// Returns null (no nudge) or { staffId, weeksSinceBreak, minWeeks, maxWeeks, severity }.
// severity: 'approaching' once weeksSinceBreak >= minWeeks, 'overdue' once
// weeksSinceBreak >= maxWeeks — two distinct states so a future UI can
// visually escalate rather than treating every nudge the same.
export function computeRestWeekNudge(staffMember, defaults, recentWeeks) {
  const policy = resolveRestWeekPolicy(staffMember, defaults);
  if (!policy.enabled) return null;

  const streak = weeksSinceLastBreak(staffMember.id, recentWeeks);
  if (streak < policy.minWeeks) return null;

  return {
    staffId: staffMember.id,
    weeksSinceBreak: streak,
    minWeeks: policy.minWeeks,
    maxWeeks: policy.maxWeeks,
    severity: streak >= policy.maxWeeks ? 'overdue' : 'approaching',
  };
}

export function computeRestWeekNudges(staff, defaults, recentWeeks) {
  return staff.map((s) => computeRestWeekNudge(s, defaults, recentWeeks)).filter((n) => n !== null);
}

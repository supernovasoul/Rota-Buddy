// UK Working Time Regulations 48-hour/17-week rolling average - a soft
// warning, not a hard block (staff can legally opt out of the 48h limit
// itself, so this tool must never refuse to generate a rota over it -
// see the working-time-warning project memory). Distinct from both hard
// rules already built: the 39h weekly cap (weeklyCap.js - a business
// policy number, configurable per person, with its own opt-in override)
// and the 11h daily rest gap (restRule.js - a genuine UK statutory
// minimum with no override at all). This is the OTHER UK working-time
// number, legally an AVERAGE over a rolling reference period rather than
// a per-week ceiling - someone can work well over 48h in a single week
// as long as it balances out over the window.
//
// Mirrors the legal reference-period rule exactly: if someone has less
// than a full 17 weeks of history yet (a new starter, or a new
// installation of this app), the average is taken over however many
// weeks they actually have - never padded, invented, or delayed until a
// full window accumulates. See restWeekNudge.js for the sibling
// soft-warning pattern this follows.

const WTR_WINDOW_WEEKS = 17;
const WTR_THRESHOLD_HOURS_PER_WEEK = 48;

// recentWeeklyHours: [hours, hours, ...] for ONE person, oldest -> newest,
// covering CLOSED weeks immediately before the one being checked (not
// including it). thisWeekHours is the week currently being solved/
// considered for closing - always included in the average.
export function rollingAverageHours(recentWeeklyHours, thisWeekHours) {
  const window = recentWeeklyHours.slice(-(WTR_WINDOW_WEEKS - 1));
  const total = window.reduce((sum, hours) => sum + hours, 0) + thisWeekHours;
  const weekCount = window.length + 1;
  return total / weekCount;
}

// Returns null (no warning) or { staffId, averageHoursPerWeek, weekCount }.
export function computeWtrWarning(staffMember, recentWeeklyHours, thisWeekHours) {
  const average = rollingAverageHours(recentWeeklyHours, thisWeekHours);
  if (average <= WTR_THRESHOLD_HOURS_PER_WEEK) return null;

  return {
    staffId: staffMember.id,
    averageHoursPerWeek: average,
    weekCount: Math.min(recentWeeklyHours.length, WTR_WINDOW_WEEKS - 1) + 1,
  };
}

export function computeWtrWarnings(staff, recentWeeklyHoursByStaffId, thisWeekHoursByStaffId) {
  return staff
    .map((s) => computeWtrWarning(s, recentWeeklyHoursByStaffId[s.id] ?? [], thisWeekHoursByStaffId[s.id] ?? 0))
    .filter((w) => w !== null);
}

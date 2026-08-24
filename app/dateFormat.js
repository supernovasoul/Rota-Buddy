// Human-readable date display, deliberately never numeric (07/08 is genuinely
// ambiguous between UK "7 Aug" and US "Jul 8" readings) - the day/month vs
// month/day preference only changes which comes first, never whether the
// month is spelled out, so both settings stay unambiguous.

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parts(dateIso) {
  const [year, month, day] = dateIso.split('-').map(Number);
  return { year, month, day };
}

function weekdayAbbr(dateIso) {
  const { year, month, day } = parts(dateIso);
  return WEEKDAY_ABBR[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

export function formatDate(dateIso, preference = 'day-month', { includeYear = true, includeWeekday = false } = {}) {
  const { year, month, day } = parts(dateIso);
  const mon = MONTH_ABBR[month - 1];
  const wd = includeWeekday ? `${weekdayAbbr(dateIso)} ` : '';
  if (preference === 'month-day') {
    return includeYear ? `${wd}${mon} ${day}, ${year}` : `${wd}${mon} ${day}`;
  }
  return includeYear ? `${wd}${day} ${mon} ${year}` : `${wd}${day} ${mon}`;
}

// Year is shown once, at the end of the range, rather than repeated on both
// sides - "10 Aug – 16 Aug 2026" reads cleanly without the redundancy of
// "10 Aug 2026 – 16 Aug 2026" for the common case of a single-week range.
// includeWeekday defaults on here (unlike formatDate) since every caller of
// a *range* is showing a rota week, where "Mon 10 Aug - Sun 16 Aug" is the
// point - a bare date range is the case that needs to opt out, not in.
export function formatDateRange(startIso, endIso, preference = 'day-month', { includeWeekday = true } = {}) {
  const start = formatDate(startIso, preference, { includeYear: false, includeWeekday });
  const end = formatDate(endIso, preference, { includeYear: true, includeWeekday });
  return `${start} – ${end}`;
}

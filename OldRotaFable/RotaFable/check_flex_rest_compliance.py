"""
COMPLIANCE CHECK: flex-worker mandatory rest week
==================================================
Rule: anyone classed as 'flex' (no fixed weekly pattern) must have at
least one full week with ZERO assigned shifts in every rolling 13-week
(roughly 3-month) window. This exists to stop a flexible worker's
pattern of hours looking, in practice, like a fixed contract - which
has real legal/contractual consequences for how they're classified.

This is a HARD constraint, not a fairness preference. It can't be
traded off, discounted, or overridden by anyone's balance in the
ledger - which is exactly why it's checked separately here rather
than folded into the fairness dimensions.

WHAT THIS SCRIPT DOES:
  1. Finds every 'flex' staff member currently employed.
  2. For each, builds a week-by-week timeline of "did they work
     any shift this week?" from their start date to the most
     recent closed period.
  3. Slides a 13-week window along that timeline. If any window
     contains NO zero-shift week at all, that's a violation -
     printed with the exact date range so it's actionable.

This script only CHECKS. It doesn't fix anything - the fix belongs
in the solver, as a hard constraint the schedule must satisfy before
it's ever generated. This script is what proves the rule is needed,
and later, what proves the solver is honouring it.

Run with:   python3 check_flex_rest_compliance.py
Requires spa_rota.db to already exist (run the generator or setup
script first).
"""

import sqlite3
from datetime import date, timedelta

DB_FILE = "spa_rota.db"
WINDOW_WEEKS = 13   # "every 3 months" ~ 13 rota weeks

conn = sqlite3.connect(DB_FILE)

flex_staff = conn.execute(
    "SELECT id, name, start_date FROM staff WHERE employment_type = 'flex' AND end_date IS NULL"
).fetchall()

if not flex_staff:
    print("No flex workers found - nothing to check.")
    conn.close()
    raise SystemExit

# all closed rota periods, oldest first
periods = conn.execute(
    "SELECT id, start_date, end_date FROM rota_periods WHERE status = 'closed' ORDER BY start_date"
).fetchall()

print(f"Checking {len(flex_staff)} flex worker(s) against the "
      f"{WINDOW_WEEKS}-week mandatory rest rule...\n")

any_violation = False

for staff_id, name, start_date in flex_staff:
    # which of these periods actually apply to this person (i.e. they'd
    # already started work)?
    relevant = [(pid, s, e) for (pid, s, e) in periods if s >= start_date]
    if len(relevant) < WINDOW_WEEKS:
        print(f"{name}: only {len(relevant)} week(s) of history so far - "
              f"too early to judge a {WINDOW_WEEKS}-week window yet.")
        continue

    # did they work at all in each of those weeks? (1 = worked, 0 = clear week)
    worked_flags = []
    for pid, s, e in relevant:
        count = conn.execute(
            """SELECT COUNT(*) FROM assignments a
               JOIN shifts sh ON sh.id = a.shift_id
               WHERE sh.period_id = ? AND a.staff_id = ?""",
            (pid, staff_id),
        ).fetchone()[0]
        worked_flags.append(1 if count > 0 else 0)

    # slide a 13-week window; if every week in it is "worked", that's a violation
    violations_for_person = []
    for i in range(len(worked_flags) - WINDOW_WEEKS + 1):
        window = worked_flags[i:i + WINDOW_WEEKS]
        if sum(window) == WINDOW_WEEKS:   # no rest week anywhere in this window
            window_start = relevant[i][1]
            window_end = relevant[i + WINDOW_WEEKS - 1][2]
            violations_for_person.append((window_start, window_end))

    if violations_for_person:
        any_violation = True
        # only report the first and last such window - a long run of
        # violations otherwise prints one line per week, which buries
        # the actionable information (find them a week off soon).
        first = violations_for_person[0]
        last = violations_for_person[-1]
        print(f"⚠ {name}: NO rest week found in the {WINDOW_WEEKS}-week "
              f"window {first[0]} to {first[1]}"
              + (f" (also violated in later windows up to {last[0]}–{last[1]})"
                 if len(violations_for_person) > 1 else ""))
    else:
        print(f"✓ {name}: compliant - always had a rest week within every "
              f"{WINDOW_WEEKS}-week window checked.")

conn.close()

print()
if any_violation:
    print("ACTION NEEDED: the flagged worker(s) above must be given a full "
          "shift-free week soon, and the rota solver needs this as a hard "
          "constraint so it stops happening automatically.")
else:
    print("All flex workers compliant.")

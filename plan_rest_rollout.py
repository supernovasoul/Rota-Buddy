"""
REST WEEK ROLLOUT PLANNER
=========================
Solves a one-off problem: right now, several flex workers have NEVER
had a rest week, because the mandatory-rest rule only just switched
on. Forcing all of them off in the same week (which is what happened
the first time solve_rota.py ran) guts capacity. This spreads their
first rest weeks out sensibly instead.

ASSUMPTIONS MADE EXPLICIT (change the constants below if these don't
fit your team):
  - MAX_OFF_PER_WEEK = 2: no more than two flex therapists rest in
    the same week, so the floor never loses more cover than that at
    once.
  - Priority order: whoever's currently most "ahead" on hours (most
    positive fairness balance) gets their rest week SOONEST - it
    also helps correct their balance. Whoever's most "owed" goes
    LAST, giving them longer to catch up on hours first.

This is a ONE-TIME catch-up plan for the current backlog. Going
forward, solve_rota.py's reactive 12-week check remains the
permanent safety net - once everyone's had one rest week, their
individual 12-week windows naturally fall on different weeks and
won't cluster like this again.

Run with:   python3 plan_rest_rollout.py
Requires spa_rota.db to already exist, with solve_rota.py already
having been run at least once (so we know which weeks are already
scheduled).
"""

import sqlite3
from datetime import date, timedelta

DB_FILE = "spa_rota.db"
MAX_OFF_PER_WEEK = 2      # <- adjust this if 2-at-once is too many/few
REST_RULE_WEEKS = 12

conn = sqlite3.connect(DB_FILE)
conn.execute("PRAGMA foreign_keys = ON")

# -----------------------------------------------------------------
# STEP 1: find who is currently non-compliant (same check used in
# solve_rota.py, kept identical so the two stay consistent)
# -----------------------------------------------------------------
recent_periods = conn.execute(
    """SELECT id, start_date, end_date FROM rota_periods
       WHERE status IN ('closed', 'published') ORDER BY start_date DESC LIMIT ?""",
    (REST_RULE_WEEKS,),
).fetchall()
recent_periods.reverse()

flex_staff = conn.execute(
    "SELECT id, name, start_date FROM staff WHERE employment_type = 'flex' AND end_date IS NULL"
).fetchall()

overdue = []
for sid, name, start_date in flex_staff:
    relevant = [p for p in recent_periods if p[1] >= start_date]
    if len(relevant) < REST_RULE_WEEKS:
        continue   # too new to judge yet - not part of this backlog
    all_worked = True
    for pid, s, e in relevant:
        count = conn.execute(
            """SELECT COUNT(*) FROM assignments a JOIN shifts sh ON sh.id = a.shift_id
               WHERE sh.period_id = ? AND a.staff_id = ?""",
            (pid, sid),
        ).fetchone()[0]
        if count == 0:
            all_worked = False
            break
    if all_worked:
        overdue.append((sid, name))

if not overdue:
    print("No backlog found - everyone currently compliant. Nothing to plan.")
    conn.close()
    raise SystemExit

print(f"{len(overdue)} flex worker(s) currently have NO rest week on record:")
for sid, name in overdue:
    print(f"  - {name}")
print()

# -----------------------------------------------------------------
# STEP 2: priority order - most "ahead" on hours goes first
# -----------------------------------------------------------------
def current_balance(staff_id):
    latest_start = recent_periods[-1][1] if recent_periods else date.today().isoformat()
    row = conn.execute(
        """SELECT ROUND(SUM(le.actual - le.entitled), 2)
           FROM ledger_events le JOIN rota_periods rp ON rp.id = le.period_id
           WHERE le.staff_id = ? AND le.dimension_id =
                 (SELECT id FROM fairness_dimensions WHERE code = 'THER_HOURS')
             AND rp.start_date >= DATE(?, '-91 days')""",
        (staff_id, latest_start),
    ).fetchone()
    return row[0] or 0.0

overdue_with_balance = [(sid, name, current_balance(sid)) for sid, name in overdue]
overdue_with_balance.sort(key=lambda row: row[2], reverse=True)   # most ahead first

print("Priority order (most ahead on hours -> rests soonest):")
for sid, name, bal in overdue_with_balance:
    print(f"  {name:<15} balance {bal:+.1f}h")
print()

# -----------------------------------------------------------------
# STEP 3: assign weeks - next available week after the last one
# that already has a rota (closed, published, or already has a
# planned rest week booked into it)
# -----------------------------------------------------------------
last_scheduled = conn.execute(
    "SELECT MAX(end_date) FROM rota_periods WHERE status IN ('closed', 'published')"
).fetchone()[0]
next_week_start = date.fromisoformat(last_scheduled) + timedelta(days=1)

plan = []
week = next_week_start
i = 0
while i < len(overdue_with_balance):
    this_week_people = overdue_with_balance[i:i + MAX_OFF_PER_WEEK]
    for sid, name, bal in this_week_people:
        plan.append((sid, name, week))
    i += MAX_OFF_PER_WEEK
    week += timedelta(weeks=1)

# -----------------------------------------------------------------
# STEP 4: save the plan and print it
# -----------------------------------------------------------------
conn.execute("DELETE FROM planned_rest_weeks WHERE status = 'planned'")  # replan cleanly if re-run
for sid, name, week_start in plan:
    conn.execute(
        """INSERT INTO planned_rest_weeks (staff_id, week_start, status, note)
           VALUES (?, ?, 'planned', 'One-time rollout: first mandatory rest week')""",
        (sid, week_start.isoformat()),
    )
conn.commit()

print("ROLLOUT PLAN (at most", MAX_OFF_PER_WEEK, "people resting per week):\n")
current_week = None
for sid, name, week_start in plan:
    if week_start != current_week:
        current_week = week_start
        print(f"  Week of {week_start}:")
    print(f"    - {name}")

print(f"\nSaved to planned_rest_weeks. solve_rota.py will now respect this "
      f"plan automatically when solving those weeks.")
conn.close()

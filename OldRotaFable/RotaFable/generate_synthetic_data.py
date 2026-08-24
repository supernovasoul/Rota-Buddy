"""
SYNTHETIC DATA GENERATOR
========================
Builds a completely FAKE spa team and roughly 6 months (26 weeks) of
rota history, so we have real volume to test the fairness ledger
and (later) the solver against.

Nothing in here is real. Names, patterns and numbers are invented.

WHAT THIS SCRIPT DOES, IN ORDER:
  1. Rebuilds a fresh database from schema.sql (same as before).
  2. Creates 16 fake staff: 6 receptionists, 10 therapists, with a
     realistic mix of full-time, part-time, fixed-day-only, and
     weekend-only patterns - directly modelling the real
     constraints you described.
  3. Walks through 26 weeks one at a time. For each week it invents
     demand, creates shifts, assigns them to whoever is genuinely
     eligible that week (respecting patterns, holiday, sickness),
     and writes the resulting entitled-vs-actual numbers to the
     fairness ledger.
  4. Prints a summary so you can sanity-check it by eye.

This assignment logic is a SIMPLE STAND-IN for the real solver
(built next). It's good enough to generate realistic, checkable
history - it is not yet the fairness-optimising engine itself.

Run with:   python3 generate_synthetic_data.py
Safe to re-run any time - it rebuilds from zero.
"""

import sqlite3
import os
import random
from datetime import date, timedelta

random.seed(42)  # fixed seed = same "random" data every run, so results are reproducible

DB_FILE = "spa_rota.db"

# -----------------------------------------------------------------
# STEP 1: fresh database
# -----------------------------------------------------------------
if os.path.exists(DB_FILE):
    os.remove(DB_FILE)

conn = sqlite3.connect(DB_FILE)
conn.execute("PRAGMA foreign_keys = ON")
with open("schema.sql") as f:
    conn.executescript(f.read())
print("Tables created from schema.sql")

# -----------------------------------------------------------------
# STEP 2: the fake team
# -----------------------------------------------------------------
TODAY = date(2026, 7, 12)          # most recent closed Sunday, script's "now"
HISTORY_WEEKS = 26                  # ~6 months
FIRST_MONDAY = TODAY - timedelta(weeks=HISTORY_WEEKS) - timedelta(days=TODAY.weekday())

# Each entry: (name, start_date, hrs_min, hrs_max, pattern)
# pattern is a list of weekday numbers they're available (0=Mon..6=Sun),
# or None meaning flexible / no fixed restriction.
RECEPTIONISTS = [
    ("Amira Khan",    FIRST_MONDAY - timedelta(days=400), 20, 24, None),
    ("Ben Carter",    FIRST_MONDAY - timedelta(days=600), 30, 35, None),
    ("Chloe Nowak",   FIRST_MONDAY - timedelta(days=200), 16, 20, [5, 6]),      # weekend only
    ("Grace Liu",     FIRST_MONDAY - timedelta(days=300), 12, 15, [0, 2, 4]),   # Mon/Wed/Fri only
    ("Harry Osei",    FIRST_MONDAY - timedelta(days=500), 30, 35, None),
    ("Isla Thompson", FIRST_MONDAY + timedelta(weeks=15), 30, 35, None),        # new starter, week 15
]

# Each entry: (name, start_date, fraction, pattern)
THERAPISTS = [
    ("Dev Patel",     FIRST_MONDAY - timedelta(days=500), 1.0, None),
    ("Elena Rossi",   FIRST_MONDAY - timedelta(days=250), 0.5, [1, 3]),   # Tue/Thu only
    ("Femi Adeyemi",  FIRST_MONDAY - timedelta(days=180), 0.8, None),
    ("Jamal Reid",    FIRST_MONDAY - timedelta(days=450), 1.0, None),
    ("Kavya Nair",    FIRST_MONDAY - timedelta(days=220), 0.6, None),
    ("Liam O'Connor", FIRST_MONDAY - timedelta(days=350), 1.0, None),
    ("Maya Singh",    FIRST_MONDAY - timedelta(days=150), 0.4, [5, 6]),   # weekend only
    ("Noah Williams", FIRST_MONDAY - timedelta(days=400), 1.0, None),
    ("Priya Sharma",  FIRST_MONDAY - timedelta(days=280), 0.7, None),
    ("Ravi Kumar",    FIRST_MONDAY + timedelta(weeks=20), 1.0, None),     # new starter, week 20
]

QUALIFICATIONS = ["massage", "facial", "body_wrap", "hot_stone"]

staff_ids = {}   # name -> id, filled in as we insert

def insert_staff(name, role, start_date, fraction, hmin, hmax, employment_type):
    cur = conn.execute(
        """INSERT INTO staff (name, role, start_date, end_date,
               proportional_fraction, contracted_hours_min, contracted_hours_max,
               employment_type)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?)""",
        (name, role, start_date.isoformat(), fraction, hmin, hmax, employment_type),
    )
    staff_ids[name] = cur.lastrowid

# flex = no fixed weekly pattern (pattern is None). Fixed-days people
# (Chloe, Grace, Elena, Maya) are 'fixed_pattern' - not subject to the
# mandatory-week-off rule, since their contract already limits their days.
for name, start, hmin, hmax, pattern in RECEPTIONISTS:
    etype = "flex" if pattern is None else "fixed_pattern"
    insert_staff(name, "receptionist", start, None, hmin, hmax, etype)
for name, start, frac, pattern in THERAPISTS:
    etype = "flex" if pattern is None else "fixed_pattern"
    insert_staff(name, "therapist", start, frac, None, None, etype)

# qualifications: give each therapist 1-3 random skills
qual_ids = {}
for q in QUALIFICATIONS:
    cur = conn.execute("INSERT INTO qualifications (name) VALUES (?)", (q,))
    qual_ids[q] = cur.lastrowid

for name, *_ in THERAPISTS:
    skills = random.sample(QUALIFICATIONS, k=random.randint(1, 3))
    for q in skills:
        conn.execute(
            "INSERT INTO staff_qualifications (staff_id, qualification_id) VALUES (?, ?)",
            (staff_ids[name], qual_ids[q]),
        )

# availability patterns: only for those with a fixed pattern; everyone else
# is treated as flexible (no pattern rows = available any day, subject to
# one-off holiday/sick/unavailable entries).
PATTERNS = {}
for name, start, hmin, hmax, pattern in RECEPTIONISTS:
    if pattern:
        PATTERNS[name] = pattern
for name, start, frac, pattern in THERAPISTS:
    if pattern:
        PATTERNS[name] = pattern

for name, days in PATTERNS.items():
    for d in range(7):
        conn.execute(
            "INSERT INTO availability_patterns (staff_id, day_of_week, available) VALUES (?, ?, ?)",
            (staff_ids[name], d, 1 if d in days else 0),
        )

# exemption: Chloe is weekend-only BY CHOICE, so weekends aren't
# "undesirable" for her - exempt from the relevant fairness dimension.
def exempt(name, code, note):
    conn.execute(
        """INSERT INTO staff_dimension_settings (staff_id, dimension_id, mode, note)
           VALUES (?, (SELECT id FROM fairness_dimensions WHERE code = ?), 'exempt', ?)""",
        (staff_ids[name], code, note),
    )

exempt("Chloe Nowak", "REC_WEEKEND", "Weekend-only by preference - agreed at hire")

conn.commit()
print(f"Inserted {len(RECEPTIONISTS)} receptionists and {len(THERAPISTS)} therapists")

# -----------------------------------------------------------------
# STEP 3: 26 weeks of history
# -----------------------------------------------------------------
BANK_HOLIDAYS = {date(2026, 5, 4), date(2026, 5, 25), date(2026, 8, 31)}

# a handful of one-off holiday/sick blocks, scattered across the year -
# (name, day it starts, length in days, type)
ONE_OFFS = [
    ("Ben Carter",    FIRST_MONDAY + timedelta(weeks=3, days=1), 5, "holiday"),
    ("Dev Patel",     FIRST_MONDAY + timedelta(weeks=8, days=2), 1, "sick"),
    ("Priya Sharma",  FIRST_MONDAY + timedelta(weeks=12, days=0), 7, "holiday"),
    ("Harry Osei",    FIRST_MONDAY + timedelta(weeks=16, days=3), 2, "sick"),
    ("Kavya Nair",    FIRST_MONDAY + timedelta(weeks=19, days=4), 1, "sick"),
    ("Femi Adeyemi",  FIRST_MONDAY + timedelta(weeks=22, days=1), 4, "holiday"),
]
for name, start, length, kind in ONE_OFFS:
    end = start + timedelta(days=length - 1)
    conn.execute(
        "INSERT INTO availability (staff_id, date_from, date_to, type, granted) VALUES (?, ?, ?, ?, 1)",
        (staff_ids[name], start.isoformat(), end.isoformat(), kind),
    )
conn.commit()

one_off_by_person = {}
for name, start, length, kind in ONE_OFFS:
    end = start + timedelta(days=length - 1)
    one_off_by_person.setdefault(name, []).append((start, end))


def is_available(name, day):
    """True if this person can work this specific date."""
    pattern = PATTERNS.get(name)
    if pattern is not None and day.weekday() not in pattern:
        return False
    for (start, end) in one_off_by_person.get(name, []):
        if start <= day <= end:
            return False
    return True


def has_started(name, day):
    return start_dates[name] <= day


start_dates = {name: start for (name, start, hmin, hmax, pattern) in RECEPTIONISTS}
start_dates.update({name: start for (name, start, frac, pattern) in THERAPISTS})

receptionist_names = [n for n, *_ in RECEPTIONISTS]
therapist_info = {n: frac for (n, s, frac, p) in THERAPISTS}
therapist_names = list(therapist_info.keys())

# running ledger balance kept in memory during generation, purely to make
# the FAKE assignment look reasonably fair (spreads weekends/hours out) -
# this is a stand-in for the real solver, not the solver itself.
running_balance = {n: 0.0 for n in receptionist_names + therapist_names}

DIMENSION_FOR_SHIFT = {"early": "REC_EARLY", "late": "REC_LATE"}

ledger_rows = []   # collected then inserted in bulk at the end

for week_num in range(HISTORY_WEEKS):
    week_start = FIRST_MONDAY + timedelta(weeks=week_num)
    week_end = week_start + timedelta(days=6)

    cur = conn.execute(
        "INSERT INTO rota_periods (start_date, end_date, status) VALUES (?, ?, 'closed')",
        (week_start.isoformat(), week_end.isoformat()),
    )
    period_id = cur.lastrowid

    all_dims = ["REC_EARLY", "REC_LATE", "REC_WEEKEND", "REC_BANK_HOL"]
    rec_entitled = {n: {d: 0.0 for d in all_dims} for n in receptionist_names}
    rec_actual = {n: {d: 0.0 for d in all_dims} for n in receptionist_names}
    ther_entitled = {n: 0.0 for n in therapist_names}
    ther_actual = {n: 0.0 for n in therapist_names}

    # ---- reception shifts: early + late, every day ----
    for i in range(7):
        day = week_start + timedelta(days=i)
        is_weekend = day.weekday() >= 5
        is_bh = day in BANK_HOLIDAYS

        for slot, is_early, is_late in [("early", 1, 0), ("late", 0, 1)]:
            conn.execute(
                """INSERT INTO shifts (period_id, date, start_time, end_time,
                       role_required, is_early, is_late, is_bank_holiday)
                   VALUES (?, ?, ?, ?, 'receptionist', ?, ?, ?)""",
                (period_id, day.isoformat(),
                 "08:00" if slot == "early" else "14:00",
                 "14:00" if slot == "early" else "20:00",
                 is_early, is_late, int(is_bh)),
            )
            shift_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]

            eligible = [n for n in receptionist_names
                        if has_started(n, day) and is_available(n, day)]
            if not eligible:
                continue  # unfilled shift - realistic, we don't force an assignment

            dims = [DIMENSION_FOR_SHIFT[slot]]
            if is_weekend:
                dims.append("REC_WEEKEND")
            if is_bh:
                dims.append("REC_BANK_HOL")

            eligible.sort(key=lambda n: running_balance[n])
            chosen = eligible[0]

            conn.execute(
                "INSERT INTO assignments (shift_id, staff_id, status, locked) VALUES (?, ?, 'worked', 0)",
                (shift_id, staff_ids[chosen]),
            )
            running_balance[chosen] += 1
            n_eligible = len(eligible)
            for d in dims:
                rec_actual[chosen][d] += 1
                for n in eligible:
                    rec_entitled[n][d] += 1.0 / n_eligible

    # ---- therapist demand + assignment ----
    for i in range(7):
        day = week_start + timedelta(days=i)
        base = 30 if day.weekday() >= 5 else 20
        demand_hours = round(base * random.uniform(0.85, 1.15), 1)
        conn.execute("INSERT INTO demand (date, forecast_hours) VALUES (?, ?)",
                     (day.isoformat(), demand_hours))

        available_today = [n for n in therapist_names
                            if has_started(n, day) and is_available(n, day)]
        if not available_today:
            continue

        total_fraction = sum(therapist_info[n] for n in available_today)
        available_today.sort(key=lambda n: running_balance[n])
        remaining_hours = demand_hours
        for idx, n in enumerate(available_today):
            share = demand_hours * (therapist_info[n] / total_fraction)
            if idx == 0:
                share *= 1.1   # nudge toward whoever's currently owed the most
            hours = round(min(share, remaining_hours), 1)
            if hours <= 0:
                continue
            remaining_hours -= hours

            conn.execute(
                """INSERT INTO shifts (period_id, date, start_time, end_time,
                       role_required, treatment_type) VALUES (?, ?, '09:00', '17:00', 'therapist', 'general')""",
                (period_id, day.isoformat()),
            )
            shift_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            conn.execute(
                "INSERT INTO assignments (shift_id, staff_id, status, locked) VALUES (?, ?, 'worked', 0)",
                (shift_id, staff_ids[n]),
            )
            ther_actual[n] += hours
            running_balance[n] += hours

        # entitlement = proportional share of demand hours, among those
        # actually available that day (this is how sick/holiday absence
        # automatically pro-rates entitlement down - absent people just
        # aren't in this list, so they can't fall behind for being off)
        for n in available_today:
            ther_entitled[n] += demand_hours * (therapist_info[n] / total_fraction)

    for n in receptionist_names:
        for code in all_dims:
            if rec_entitled[n][code] > 0 or rec_actual[n][code] > 0:
                ledger_rows.append((staff_ids[n], code, period_id,
                                     round(rec_entitled[n][code], 2),
                                     round(rec_actual[n][code], 2),
                                     "period_close", None))
    for n in therapist_names:
        if ther_entitled[n] > 0 or ther_actual[n] > 0:
            ledger_rows.append((staff_ids[n], "THER_HOURS", period_id,
                                 round(ther_entitled[n], 2),
                                 round(ther_actual[n], 2),
                                 "period_close", None))

conn.executemany(
    """INSERT INTO ledger_events
       (staff_id, dimension_id, period_id, entitled, actual, event_type, note)
       VALUES (?, (SELECT id FROM fairness_dimensions WHERE code = ?), ?, ?, ?, ?, ?)""",
    ledger_rows,
)
conn.commit()
print(f"Generated {HISTORY_WEEKS} weeks of shifts, assignments and ledger history")

# -----------------------------------------------------------------
# STEP 4: summary + the fairness query, so you can eyeball it
# -----------------------------------------------------------------
n_shifts = conn.execute("SELECT COUNT(*) FROM shifts").fetchone()[0]
n_assignments = conn.execute("SELECT COUNT(*) FROM assignments").fetchone()[0]
n_unfilled = n_shifts - n_assignments
print(f"\n{n_shifts} shifts created, {n_assignments} filled, {n_unfilled} unfilled (realistic gaps)")

print("\nROLLING FAIRNESS BALANCES (last 13 weeks, current staff only)")
print("positive = had more than their share | negative = owed\n")

query = """
SELECT
    s.name,
    fd.code AS dimension,
    ROUND(SUM(le.actual - le.entitled), 1) AS balance,
    CASE WHEN sds.mode = 'exempt' THEN 'EXEMPT' ELSE '' END AS override
FROM ledger_events le
JOIN staff s ON s.id = le.staff_id
JOIN fairness_dimensions fd ON fd.id = le.dimension_id
JOIN rota_periods rp ON rp.id = le.period_id
LEFT JOIN staff_dimension_settings sds
       ON sds.staff_id = s.id AND sds.dimension_id = fd.id
WHERE rp.start_date >= DATE(?, '-91 days')
  AND s.end_date IS NULL
GROUP BY s.name, fd.code
ORDER BY fd.code, s.name;
"""

for name, dim, balance, override in conn.execute(query, (TODAY.isoformat(),)):
    flag = f"  <- {override}" if override else ""
    print(f"  {name:<15} {dim:<16} {balance:+6.1f}{flag}")

conn.close()
print(f"\nDone. Database saved as {DB_FILE}")

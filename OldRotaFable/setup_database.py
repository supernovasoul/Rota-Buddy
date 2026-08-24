"""
SETUP SCRIPT — builds the spa rota database from scratch.

What this script does, in order:
  1. Deletes any old copy of the database file (safe: synthetic data only).
  2. Creates a fresh database file called spa_rota.db.
  3. Runs schema.sql to create all the empty tables.
  4. Inserts a small SYNTHETIC team (fake people, fake history)
     so there is something to query.
  5. Runs the rolling fairness-balance query and prints the result,
     proving the whole design actually works end to end.

Run it from the terminal with:   python3 setup_database.py
Run it as many times as you like — it rebuilds from zero each time.
"""

import sqlite3   # Python's built-in tool for talking to SQLite databases
import os        # lets us delete the old file

DB_FILE = "spa_rota.db"

# ---------------------------------------------------------------
# STEP 1 + 2: fresh database file
# ---------------------------------------------------------------
if os.path.exists(DB_FILE):
    os.remove(DB_FILE)
    print(f"Removed old {DB_FILE}")

# "connect" opens the database file (creating it if it doesn't exist).
# Everything we do goes through this connection.
conn = sqlite3.connect(DB_FILE)
conn.execute("PRAGMA foreign_keys = ON")

# ---------------------------------------------------------------
# STEP 3: build the tables from the blueprint
# ---------------------------------------------------------------
with open("schema.sql") as f:
    conn.executescript(f.read())   # runs every command in schema.sql
print("Tables created from schema.sql")

# ---------------------------------------------------------------
# STEP 4: synthetic team — entirely fake, safe to publish
# ---------------------------------------------------------------
# The ? marks are placeholders: sqlite fills them in with the values
# provided alongside. This is the standard safe way to insert data.

staff = [
    # (name, role, start_date, end_date, fraction, hrs_min, hrs_max)
    ("Amira Khan",   "receptionist", "2024-03-01", None, None, 20, 24),
    ("Ben Carter",   "receptionist", "2023-06-15", None, None, 30, 35),
    ("Chloe Nowak",  "receptionist", "2025-01-10", None, None, 16, 20),  # weekend-only (see below)
    ("Dev Patel",    "therapist",    "2023-09-01", None, 1.0,  None, None),
    ("Elena Rossi",  "therapist",    "2024-11-20", None, 0.5,  None, None),  # part-time
    ("Femi Adeyemi", "therapist",    "2026-05-04", None, 0.8,  None, None),  # new starter
]
conn.executemany(
    """INSERT INTO staff
       (name, role, start_date, end_date, proportional_fraction,
        contracted_hours_min, contracted_hours_max)
       VALUES (?, ?, ?, ?, ?, ?, ?)""",
    staff,
)

# Availability patterns: Elena only works Tuesdays (1) and Thursdays (3).
# Chloe only works Saturdays (5) and Sundays (6).
patterns = [
    (5, 1, 1), (5, 3, 1),          # Elena: Tue + Thu
    (3, 5, 1), (3, 6, 1),          # Chloe: Sat + Sun
]
conn.executemany(
    "INSERT INTO availability_patterns (staff_id, day_of_week, available) VALUES (?, ?, ?)",
    patterns,
)

# The override switch in action: Chloe WANTS weekends, so weekends
# aren't "undesirable" for her -> exempt from the weekend dimension.
conn.execute(
    """INSERT INTO staff_dimension_settings (staff_id, dimension_id, mode, note)
       VALUES (3, (SELECT id FROM fairness_dimensions WHERE code = 'REC_WEEKEND'),
               'exempt', 'Weekend-only by preference - agreed at hire')"""
)

# Two closed rota periods inside the rolling window, one ancient one
# outside it (to prove the window actually excludes old history).
conn.executemany(
    "INSERT INTO rota_periods (start_date, end_date, status) VALUES (?, ?, ?)",
    [
        ("2025-09-01", "2025-09-07", "closed"),   # ~10 months ago: OUTSIDE window
        ("2026-06-22", "2026-06-28", "closed"),   # inside window
        ("2026-06-29", "2026-07-05", "closed"),   # inside window
    ],
)

# Ledger events. Read each row as:
# (person, dimension, period, what they were ENTITLED to, what they ACTUALLY got)
ledger = [
    # --- Ancient period (id 1): should be ignored by the query ---
    (1, "REC_WEEKEND", 1, 1.0, 5.0, "period_close", None),  # huge old imbalance, must not count

    # --- Week of 22 June (period id 2) ---
    (1, "REC_WEEKEND", 2, 1.0, 2.0, "period_close", None),          # Amira: one weekend over
    (2, "REC_WEEKEND", 2, 1.0, 0.0, "period_close", None),          # Ben: one under
    (4, "THER_HOURS",  2, 30.0, 30.0, "period_close", None),        # Dev: exactly entitled
    (5, "THER_HOURS",  2, 15.0, 12.0, "period_close", None),        # Elena: 3 hrs under

    # --- Week of 29 June (period id 3) ---
    (1, "REC_WEEKEND", 3, 1.0, 1.0, "period_close", None),
    (2, "REC_WEEKEND", 3, 1.0, 1.0, "period_close", None),
    (4, "THER_HOURS",  3, 30.0, 24.0, "period_close", None),        # Dev worked less...
    (6, "THER_HOURS",  3, 24.0, 30.0, "period_close", None),        # ...Femi covered extra
    # Dev was off sick 1 day that week -> retroactive ADJUSTMENT
    # reducing his entitlement for the missed day (append-only fix):
    (4, "THER_HOURS",  3, -6.0, 0.0, "adjustment",
     "Sick Wed 1 Jul - entitlement pro-rated down by 6 hrs"),
]
conn.executemany(
    """INSERT INTO ledger_events
       (staff_id, dimension_id, period_id, entitled, actual, event_type, note)
       VALUES (?, (SELECT id FROM fairness_dimensions WHERE code = ?), ?, ?, ?, ?, ?)""",
    ledger,
)

conn.commit()   # save everything to the file (until commit, changes are provisional)
print("Synthetic team and ledger history inserted")

# ---------------------------------------------------------------
# STEP 5: the fairness query — the number the solver will use
# ---------------------------------------------------------------
print("\nROLLING FAIRNESS BALANCES (last 13 weeks)")
print("positive = had more than their share | negative = owed\n")

query = """
SELECT
    s.name,
    fd.code                                  AS dimension,
    ROUND(SUM(le.actual - le.entitled), 1)   AS balance,
    CASE WHEN sds.mode = 'exempt' THEN 'EXEMPT' ELSE '' END AS override
FROM ledger_events le
JOIN staff s              ON s.id  = le.staff_id
JOIN fairness_dimensions fd ON fd.id = le.dimension_id
JOIN rota_periods rp      ON rp.id = le.period_id
LEFT JOIN staff_dimension_settings sds
       ON sds.staff_id = s.id AND sds.dimension_id = fd.id
WHERE rp.start_date >= DATE('now', '-91 days')   -- the 13-week window
  AND s.end_date IS NULL                          -- current staff only
GROUP BY s.name, fd.code
ORDER BY fd.code, s.name;
"""

for name, dim, balance, override in conn.execute(query):
    flag = f"  <- {override}" if override else ""
    print(f"  {name:<14} {dim:<16} {balance:+6.1f}{flag}")

conn.close()
print(f"\nDone. Database saved as {DB_FILE}")

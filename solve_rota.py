"""
ROTA SOLVER — the real engine, replacing the greedy stand-in.
================================================================
Uses Google OR-Tools' CP-SAT: a "constraint solver." Instead of
picking shifts one at a time like the generator's placeholder did,
this looks at the WHOLE week at once and finds an assignment that
satisfies every hard rule simultaneously, while minimising unfairness
as a single combined objective.

HARD RULES (must never be broken):
  - Every reception shift needs exactly one person, from whoever is
    actually eligible that day (pattern + no leave + already started).
  - Therapist hours each day must add up to that day's demand.
  - Flex workers who've had NO rest week in the last 12 weeks are
    forced to zero shifts this week - the mandatory-rest rule,
    enforced BEFORE a rota is ever produced, not checked afterwards.

SOFT GOAL (optimised, not enforced):
  - Minimise how far this week pushes everyone's rolling fairness
    balance from zero, using the existing ledger history as the
    starting point.

WHAT'S DELIBERATELY SIMPLIFIED FOR THIS FIRST VERSION (noted
honestly, not hidden):
  - No treatment-type/qualification matching yet (assumes any
    therapist can take any treatment slot).
  - No shift preferences yet (preference_off/on rows are ignored -
    they'll become a soft cost term next).
  - No explicit 11-hour rest-between-shifts rule yet (only one
    shift block per person per day exists at this stage, so it
    can't yet be violated - becomes relevant once shift patterns
    get finer-grained).

Run with:   python3 solve_rota.py
Requires spa_rota.db to already exist.
"""

import sqlite3
from datetime import date, timedelta
from ortools.sat.python import cp_model

DB_FILE = "spa_rota.db"
SCALE = 100          # keeps fractional fairness numbers as whole integers
                      # (CP-SAT only works with integers, not decimals)
WINDOW_WEEKS = 13     # rolling fairness window
REST_RULE_WEEKS = 12  # trailing weeks checked for the mandatory-rest rule

conn = sqlite3.connect(DB_FILE)
conn.execute("PRAGMA foreign_keys = ON")

# -----------------------------------------------------------------
# STEP 1: work out which week we're solving - the one right after
# the most recent closed period.
# -----------------------------------------------------------------
last_end = conn.execute(
    "SELECT MAX(end_date) FROM rota_periods WHERE status IN ('closed', 'published')"
).fetchone()[0]
week_start = date.fromisoformat(last_end) + timedelta(days=1)
week_end = week_start + timedelta(days=6)
print(f"Solving rota for {week_start} to {week_end}\n")

cur = conn.execute(
    "INSERT INTO rota_periods (start_date, end_date, status) VALUES (?, ?, 'draft')",
    (week_start.isoformat(), week_end.isoformat()),
)
period_id = cur.lastrowid

# -----------------------------------------------------------------
# STEP 2: load staff and their availability rules
# -----------------------------------------------------------------
staff = conn.execute(
    """SELECT id, name, role, employment_type, proportional_fraction, start_date
       FROM staff WHERE end_date IS NULL"""
).fetchall()

patterns = {}   # staff_id -> set of available weekdays, or absent = fully flexible
for staff_id, day, available in conn.execute(
    "SELECT staff_id, day_of_week, available FROM availability_patterns"
):
    patterns.setdefault(staff_id, set())
    if available:
        patterns[staff_id].add(day)

leave = {}   # staff_id -> list of (date_from, date_to) for holiday/sick/unavailable
for staff_id, date_from, date_to in conn.execute(
    """SELECT staff_id, date_from, date_to FROM availability
       WHERE type IN ('holiday', 'sick', 'unavailable')
         AND date_from <= ? AND date_to >= ?""",
    (week_end.isoformat(), week_start.isoformat()),
):
    leave.setdefault(staff_id, []).append(
        (date.fromisoformat(date_from), date.fromisoformat(date_to))
    )


def is_available(staff_id, day):
    if staff_id in patterns and day.weekday() not in patterns[staff_id]:
        return False
    for (f, t) in leave.get(staff_id, []):
        if f <= day <= t:
            return False
    return True


def has_started(start_date_str, day):
    return date.fromisoformat(start_date_str) <= day

receptionists = [(sid, n) for (sid, n, role, et, frac, sd) in staff if role == "receptionist"]
therapists = [(sid, n, frac) for (sid, n, role, et, frac, sd) in staff if role == "therapist"]
start_dates = {sid: sd for (sid, n, role, et, frac, sd) in staff}
employment_type = {sid: et for (sid, n, role, et, frac, sd) in staff}
names = {sid: n for (sid, n, role, et, frac, sd) in staff}

# -----------------------------------------------------------------
# STEP 3: mandatory rest-week rule - decide who MUST be off this week
# -----------------------------------------------------------------
recent_periods = conn.execute(
    """SELECT id, start_date, end_date FROM rota_periods
       WHERE status = 'closed' ORDER BY start_date DESC LIMIT ?""",
    (REST_RULE_WEEKS,),
).fetchall()
recent_periods.reverse()

forced_off = set()

# 1. PROACTIVE: anyone with a planned rest week landing on this exact
# week, from the rollout plan (handles the current backlog sensibly,
# a few people at a time, instead of everyone at once).
planned_this_week = conn.execute(
    """SELECT staff_id FROM planned_rest_weeks
       WHERE week_start = ? AND status = 'planned'""",
    (week_start.isoformat(),),
).fetchall()
for (sid,) in planned_this_week:
    forced_off.add(sid)

if forced_off:
    print("Rest week taken this week (from rollout plan) for:")
    for sid in forced_off:
        print(f"  - {names[sid]}")

# 2. REACTIVE: the permanent ongoing safety net - anyone who somehow
# still hits 12 straight worked weeks (e.g. a future employee not
# covered by the one-time rollout) gets caught here regardless.
reactive_forced = set()
already_planned = {row[0] for row in conn.execute(
    "SELECT DISTINCT staff_id FROM planned_rest_weeks"
).fetchall()}
for sid, name, role, et, frac, sd in staff:
    if et != "flex" or len(recent_periods) < REST_RULE_WEEKS or sid in forced_off:
        continue
    if sid in already_planned:
        continue   # trust the rollout plan - their rest week is already scheduled
    all_worked = True
    for pid, pstart, pend in recent_periods:
        count = conn.execute(
            """SELECT COUNT(*) FROM assignments a JOIN shifts sh ON sh.id = a.shift_id
               WHERE sh.period_id = ? AND a.staff_id = ?""",
            (pid, sid),
        ).fetchone()[0]
        if count == 0:
            all_worked = False
            break
    if all_worked:
        reactive_forced.add(sid)

if reactive_forced:
    print("Mandatory rest week ALSO reactively enforced (not covered by "
          "rollout plan) for:")
    for sid in reactive_forced:
        print(f"  - {names[sid]}")
    forced_off |= reactive_forced

if forced_off:
    print()

# -----------------------------------------------------------------
# STEP 4: rolling fairness balances as of NOW (before this week)
# -----------------------------------------------------------------
def existing_balance(staff_id, dimension_code):
    row = conn.execute(
        """SELECT ROUND(SUM(le.actual - le.entitled), 4)
           FROM ledger_events le JOIN rota_periods rp ON rp.id = le.period_id
           WHERE le.staff_id = ? AND le.dimension_id =
                 (SELECT id FROM fairness_dimensions WHERE code = ?)
             AND rp.start_date >= DATE(?, '-91 days')""",
        (staff_id, dimension_code, week_start.isoformat()),
    ).fetchone()
    return row[0] or 0.0


def is_exempt(staff_id, dimension_code):
    row = conn.execute(
        """SELECT mode FROM staff_dimension_settings
           WHERE staff_id = ? AND dimension_id =
                 (SELECT id FROM fairness_dimensions WHERE code = ?)""",
        (staff_id, dimension_code),
    ).fetchone()
    return row is not None and row[0] == "exempt"

# -----------------------------------------------------------------
# STEP 5: build the CP-SAT model
# -----------------------------------------------------------------
model = cp_model.CpModel()
reception_vars = {}   # (staff_id, shift_key) -> BoolVar
shift_meta = {}        # shift_key -> dict of day/slot/is_weekend/is_bh
dimension_shift_map = {"early": "REC_EARLY", "late": "REC_LATE"}

for i in range(7):
    day = week_start + timedelta(days=i)
    is_weekend = day.weekday() >= 5
    is_bh = False  # bank holidays aren't in this rolling week by default; extend if needed

    for slot in ("early", "late"):
        shift_key = (day.isoformat(), slot)
        shift_meta[shift_key] = dict(day=day, slot=slot, is_weekend=is_weekend, is_bh=is_bh)

        eligible = [sid for sid, n in receptionists
                    if has_started(start_dates[sid], day)
                    and is_available(sid, day)
                    and sid not in forced_off]

        vars_this_shift = []
        for sid in eligible:
            v = model.NewBoolVar(f"x_{sid}_{day}_{slot}")
            reception_vars[(sid, shift_key)] = v
            vars_this_shift.append(v)

        if vars_this_shift:
            # hard rule: exactly one person covers this shift
            model.Add(sum(vars_this_shift) == 1)
        # if nobody is eligible, the shift stays genuinely unfilled -
        # a real gap the manager needs to know about, not hidden.

# -----------------------------------------------------------------
# STEP 6: therapist hours as integer variables per person per day
# -----------------------------------------------------------------
therapist_hours = {}   # (staff_id, day_iso) -> IntVar
MAX_HOURS_PER_DAY = 8

for i in range(7):
    day = week_start + timedelta(days=i)
    base = 30 if day.weekday() >= 5 else 20
    demand_hours = base   # deterministic forecast for a forward plan (no randomness)
    conn.execute("INSERT INTO demand (date, forecast_hours) VALUES (?, ?)",
                 (day.isoformat(), float(demand_hours)))

    available_today = [sid for sid, n, frac in therapists
                        if has_started(start_dates[sid], day)
                        and is_available(sid, day)
                        and sid not in forced_off]

    day_vars = []
    for sid in available_today:
        v = model.NewIntVar(0, MAX_HOURS_PER_DAY, f"h_{sid}_{day}")
        therapist_hours[(sid, day.isoformat())] = v
        day_vars.append(v)

    if day_vars:
        capacity = len(day_vars) * MAX_HOURS_PER_DAY
        target = min(demand_hours, capacity)   # can't demand more than physically possible
        if target < demand_hours:
            print(f"NOTE: {day} demand is {demand_hours}h but only {capacity}h of "
                  f"therapist capacity available - target reduced to {target}h.")
        model.Add(sum(day_vars) == target)

# -----------------------------------------------------------------
# STEP 7: fairness objective - minimise total deviation from zero
# -----------------------------------------------------------------
objective_terms = []

for sid, name in receptionists:
    for slot, dim_code in dimension_shift_map.items():
        if is_exempt(sid, dim_code):
            continue
        shifts_this_dim = [k for k in shift_meta if shift_meta[k]["slot"] == slot
                            and (sid, k) in reception_vars]
        if not shifts_this_dim:
            continue
        actual_expr = sum(reception_vars[(sid, k)] for k in shifts_this_dim)

        # fair share: for each shift this dimension covers, this person's
        # slice is 1/(number eligible for that shift) - a constant, since
        # it depends only on WHO COULD work it, not what the solver picks
        fair_share = 0.0
        for k in shifts_this_dim:
            n_eligible = sum(1 for (s2, k2) in reception_vars if k2 == k)
            fair_share += 1.0 / n_eligible

        existing_scaled = round(existing_balance(sid, dim_code) * SCALE)
        fair_share_scaled = round(fair_share * SCALE)

        projected = existing_scaled + SCALE * actual_expr - fair_share_scaled
        dev_pos = model.NewIntVar(0, 100000, f"devpos_{sid}_{dim_code}")
        dev_neg = model.NewIntVar(0, 100000, f"devneg_{sid}_{dim_code}")
        model.Add(dev_pos - dev_neg == projected)
        objective_terms.extend([dev_pos, dev_neg])

    # weekend dimension: any shift on a Sat/Sun counts, regardless of slot
    if not is_exempt(sid, "REC_WEEKEND"):
        weekend_shifts = [k for k in shift_meta if shift_meta[k]["is_weekend"]
                           and (sid, k) in reception_vars]
        if weekend_shifts:
            actual_expr = sum(reception_vars[(sid, k)] for k in weekend_shifts)
            fair_share = 0.0
            for k in weekend_shifts:
                n_eligible = sum(1 for (s2, k2) in reception_vars if k2 == k)
                fair_share += 1.0 / n_eligible
            existing_scaled = round(existing_balance(sid, "REC_WEEKEND") * SCALE)
            fair_share_scaled = round(fair_share * SCALE)
            projected = existing_scaled + SCALE * actual_expr - fair_share_scaled
            dev_pos = model.NewIntVar(0, 100000, f"devpos_{sid}_weekend")
            dev_neg = model.NewIntVar(0, 100000, f"devneg_{sid}_weekend")
            model.Add(dev_pos - dev_neg == projected)
            objective_terms.extend([dev_pos, dev_neg])

for sid, name, frac in therapists:
    days_available = [d for d in [(week_start + timedelta(days=i)) for i in range(7)]
                       if (sid, d.isoformat()) in therapist_hours]
    if not days_available:
        continue
    actual_expr = sum(therapist_hours[(sid, d.isoformat())] for d in days_available)

    # entitlement: proportional share of each available day's demand,
    # among everyone available that day - precomputed constant, since
    # availability (not the solver's choice) determines who's in the pool
    entitled_hours = 0.0
    for d in days_available:
        base = 30 if d.weekday() >= 5 else 20
        pool = [(s2, f2) for (s2, n2, f2) in therapists
                if has_started(start_dates[s2], d) and is_available(s2, d)
                and s2 not in forced_off]
        total_frac = sum(f for (s2, f) in pool) or 1.0
        entitled_hours += base * (frac / total_frac)

    existing_scaled = round(existing_balance(sid, "THER_HOURS") * SCALE)
    entitled_scaled = round(entitled_hours * SCALE)
    projected = existing_scaled + SCALE * actual_expr - entitled_scaled
    dev_pos = model.NewIntVar(0, 1000000, f"devpos_{sid}_hours")
    dev_neg = model.NewIntVar(0, 1000000, f"devneg_{sid}_hours")
    model.Add(dev_pos - dev_neg == projected)
    objective_terms.extend([dev_pos, dev_neg])

model.Minimize(sum(objective_terms))

# -----------------------------------------------------------------
# STEP 7b: tie-breaker.
# The pure fairness objective above is an absolute-deviation (L1)
# score. If two or more people are EXACTLY equally owed, giving all
# the shifts to one of them and none to the other can score
# identically to splitting the shifts between them - both are
# "optimal" by that measure alone, so the solver may arbitrarily
# pick the lumpy-looking one. This adds a tiny secondary preference
# for spreading shifts evenly across people, without changing which
# allocation is fairness-optimal (the added values are far smaller
# than one fairness scale-step, so they only break genuine ties).
# -----------------------------------------------------------------
for sid, name in receptionists:
    relevant_vars = [v for (s2, k), v in reception_vars.items() if s2 == sid]
    if not relevant_vars:
        continue
    total_var = model.NewIntVar(0, len(relevant_vars), f"total_{sid}")
    model.Add(total_var == sum(relevant_vars))
    sq_var = model.NewIntVar(0, len(relevant_vars) ** 2, f"sq_{sid}")
    model.AddMultiplicationEquality(sq_var, [total_var, total_var])
    objective_terms.append(sq_var)

model.Minimize(sum(objective_terms))

# -----------------------------------------------------------------
# STEP 8: solve
# -----------------------------------------------------------------
solver = cp_model.CpSolver()
solver.parameters.max_time_in_seconds = 15
solver.parameters.num_search_workers = 8
status = solver.Solve(model)

if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
    print("NO SOLUTION FOUND - the hard constraints can't all be satisfied "
          "as given. This is exactly the case where the system should "
          "explain WHY, rather than silently failing (see project notes).")
    conn.close()
    raise SystemExit

print(f"Solved. Status: {solver.StatusName(status)}, "
      f"total fairness deviation score: {solver.ObjectiveValue():.0f}\n")

# -----------------------------------------------------------------
# STEP 9: write the result into the database and print it
# -----------------------------------------------------------------
print("RECEPTION ROTA")
for i in range(7):
    day = week_start + timedelta(days=i)
    line = f"  {day} ({day.strftime('%a')}): "
    parts = []
    for slot, start_t, end_t, is_e, is_l in [("early", "08:00", "14:00", 1, 0),
                                              ("late", "14:00", "20:00", 0, 1)]:
        key = (day.isoformat(), slot)
        assigned = [sid for (sid, k) in reception_vars
                    if k == key and solver.Value(reception_vars[(sid, k)]) == 1]
        conn.execute(
            """INSERT INTO shifts (period_id, date, start_time, end_time,
                   role_required, is_early, is_late, is_bank_holiday)
               VALUES (?, ?, ?, ?, 'receptionist', ?, ?, 0)""",
            (period_id, day.isoformat(), start_t, end_t, is_e, is_l),
        )
        shift_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        if assigned:
            conn.execute(
                "INSERT INTO assignments (shift_id, staff_id, status, locked) VALUES (?, ?, 'assigned', 0)",
                (shift_id, assigned[0]),
            )
            parts.append(f"{slot}={names[assigned[0]]}")
        else:
            parts.append(f"{slot}=UNFILLED")
    print(line + ", ".join(parts))

print("\nTHERAPIST HOURS")
for i in range(7):
    day = week_start + timedelta(days=i)
    day_entries = [(sid, solver.Value(v)) for (sid, d), v in therapist_hours.items()
                   if d == day.isoformat() and solver.Value(v) > 0]
    if not day_entries:
        print(f"  {day} ({day.strftime('%a')}): no hours allocated")
        continue
    summary = ", ".join(f"{names[sid]}={hrs}h" for sid, hrs in day_entries)
    print(f"  {day} ({day.strftime('%a')}): {summary}")
    for sid, hrs in day_entries:
        conn.execute(
            """INSERT INTO shifts (period_id, date, start_time, end_time,
                   role_required, treatment_type) VALUES (?, ?, '09:00', '17:00', 'therapist', 'general')""",
            (period_id, day.isoformat()),
        )
        shift_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.execute(
            "INSERT INTO assignments (shift_id, staff_id, status, locked) VALUES (?, ?, 'assigned', 0)",
            (shift_id, sid),
        )

conn.execute("UPDATE rota_periods SET status = 'published' WHERE id = ?", (period_id,))
conn.execute(
    "UPDATE planned_rest_weeks SET status = 'taken' WHERE week_start = ? AND status = 'planned'",
    (week_start.isoformat(),),
)
conn.commit()
print(f"\nRota saved as period {period_id} (status: published). "
      f"Ledger entries are written once the week actually happens and the "
      f"period is closed - not before, since the ledger only ever records "
      f"reality.")
conn.close()

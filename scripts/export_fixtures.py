"""
FIXTURE EXPORTER — Phase 1 of the RotaFable v2 rebuild.
=========================================================
Produces JSON snapshots of solver INPUT state (not solved output) for the
Phase 2 equivalence test, which will run the same input through both the
Python solver (adapted to take/return JSON) and the new JS engine and
compare results.

This script deliberately mirrors solve_rota.py's STEP 1-4 (input-gathering)
logic exactly, so the fixtures represent genuinely realistic input state,
not synthetic guesses. It does NOT solve anything and does NOT write to
the database.

Produces three fixtures in ../app/fixtures/:
  - normal_week.json        2026-08-03 - no forced rest, ordinary week
  - forced_rest_week.json   2026-07-20 - two flex therapists forced off
                             (matches the real solved output already in
                             rota_view.html, so it doubles as a sanity check)
  - infeasible_day.json     built from normal_week.json by removing all
                             receptionist availability on one day - there's
                             no naturally-occurring infeasible day in the
                             test data, so this one is deliberately
                             constructed, not pulled from history.

WHAT THESE FIXTURES CAN AND CAN'T PROVE (read before using them in Phase 2):
  These fixtures only capture the concepts that already exist in the OLD
  schema/solver: staff, availability, forced-off logic, rolling ledger
  balances. They CAN be used to prove equivalence on the rules that carry
  over from Python: mandatory rest-week forcing, the rolling-balance ledger
  math, and proportional therapist-hours entitlement.

  They CANNOT be used to test anything that's new in v2 and has no Python
  equivalent: the 39h weekly cap, the 11h rest-between-shifts rule, the
  coverage-based reception hard rule, hours-based reception fairness, the
  Working Time Regulations warning, or priority weighting. Those need
  fresh, hand-built test scenarios in Phase 2 with manually verified
  expected results, since there's nothing in Python to diff against.

Run with:   python3 scripts/export_fixtures.py
Requires spa_rota.db to already exist (run from the RotaFable/ directory).
"""

import json
import sqlite3
from datetime import date, timedelta

DB_FILE = "spa_rota.db"
OUT_DIR = "app/fixtures"
REST_RULE_WEEKS = 12

conn = sqlite3.connect(DB_FILE)
conn.execute("PRAGMA foreign_keys = ON")


def load_staff():
    staff = conn.execute(
        """SELECT id, name, role, employment_type, proportional_fraction, start_date, end_date
           FROM staff ORDER BY id"""
    ).fetchall()
    return [
        dict(id=sid, name=name, role=role, employmentType=et,
             proportionalFraction=frac, startDate=sd, endDate=ed)
        for sid, name, role, et, frac, sd, ed in staff
    ]


def load_patterns():
    patterns = []
    for staff_id, day, available in conn.execute(
        "SELECT staff_id, day_of_week, available FROM availability_patterns"
    ):
        patterns.append(dict(staffId=staff_id, dayOfWeek=day, available=bool(available)))
    return patterns


def load_leave(week_start, week_end):
    leave = []
    for staff_id, date_from, date_to, leave_type, note in conn.execute(
        """SELECT staff_id, date_from, date_to, type, note FROM availability
           WHERE type IN ('holiday', 'sick', 'unavailable')
             AND date_from <= ? AND date_to >= ?""",
        (week_end.isoformat(), week_start.isoformat()),
    ):
        leave.append(dict(staffId=staff_id, dateFrom=date_from, dateTo=date_to,
                           type=leave_type, note=note))
    return leave


def compute_forced_off(week_start, staff_rows):
    """Exact mirror of solve_rota.py STEP 3: proactive plan + reactive 12-week check."""
    names = {s["id"]: s["name"] for s in staff_rows}
    employment_type = {s["id"]: s["employmentType"] for s in staff_rows}
    start_dates = {s["id"]: s["startDate"] for s in staff_rows}

    forced_off = set()
    # solve_rota.py only ever checks status='planned', because in real use it
    # always runs BEFORE the week happens (rows flip to 'taken' at the end of
    # that same run). Reconstructing forced-off for an already-solved past
    # week from today's database means those rows have since flipped to
    # 'taken', so both statuses must be accepted here to recover history
    # correctly - this is a fixture-reconstruction detail, not a change to
    # the actual rule.
    planned_this_week = conn.execute(
        "SELECT staff_id FROM planned_rest_weeks WHERE week_start = ? AND status IN ('planned', 'taken')",
        (week_start.isoformat(),),
    ).fetchall()
    for (sid,) in planned_this_week:
        forced_off.add(sid)

    recent_periods = conn.execute(
        """SELECT id, start_date, end_date FROM rota_periods
           WHERE status = 'closed' ORDER BY start_date DESC LIMIT ?""",
        (REST_RULE_WEEKS,),
    ).fetchall()
    recent_periods.reverse()

    already_planned = {row[0] for row in conn.execute(
        "SELECT DISTINCT staff_id FROM planned_rest_weeks"
    ).fetchall()}

    reactive_forced = set()
    for sid in employment_type:
        if employment_type[sid] != "flex" or len(recent_periods) < REST_RULE_WEEKS or sid in forced_off:
            continue
        if sid in already_planned:
            continue
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

    forced_off |= reactive_forced
    return sorted(forced_off), {
        "proactive": sorted(s for s in forced_off if s not in reactive_forced),
        "reactive": sorted(reactive_forced),
    }


def existing_balances(week_start, staff_rows):
    """Exact mirror of solve_rota.py's existing_balance(): rolling 91-day ledger sum per dimension."""
    dims = [row[0] for row in conn.execute("SELECT code FROM fairness_dimensions")]
    out = {}
    for s in staff_rows:
        sid = s["id"]
        out[str(sid)] = {}
        for code in dims:
            row = conn.execute(
                """SELECT ROUND(SUM(le.actual - le.entitled), 4)
                   FROM ledger_events le JOIN rota_periods rp ON rp.id = le.period_id
                   WHERE le.staff_id = ? AND le.dimension_id =
                         (SELECT id FROM fairness_dimensions WHERE code = ?)
                     AND rp.start_date >= DATE(?, '-91 days')""",
                (sid, code, week_start.isoformat()),
            ).fetchone()
            balance = row[0] or 0.0
            if balance != 0.0:
                out[str(sid)][code] = balance
    return out


def exemptions():
    out = []
    for staff_id, code, mode, note in conn.execute(
        """SELECT sds.staff_id, fd.code, sds.mode, sds.note
           FROM staff_dimension_settings sds JOIN fairness_dimensions fd ON fd.id = sds.dimension_id"""
    ):
        out.append(dict(staffId=staff_id, dimensionCode=code, mode=mode, note=note))
    return out


def build_fixture(week_start_str, label, notes):
    week_start = date.fromisoformat(week_start_str)
    week_end = week_start + timedelta(days=6)
    staff_rows = load_staff()
    forced_off, forced_off_detail = compute_forced_off(week_start, staff_rows)

    return {
        "fixtureLabel": label,
        "notes": notes,
        "weekStart": week_start.isoformat(),
        "weekEnd": week_end.isoformat(),
        "staff": staff_rows,
        "availabilityPatterns": load_patterns(),
        "leave": load_leave(week_start, week_end),
        "forcedOff": forced_off,
        "forcedOffDetail": forced_off_detail,
        "existingLedgerBalances": existing_balances(week_start, staff_rows),
        "staffDimensionSettings": exemptions(),
        # old solver's deterministic demand rule, preserved as-is for this fixture;
        # v2's real demand input UI supersedes this, see project memory
        "demandRule": {"weekdayHours": 20, "weekendHours": 30},
    }


def main():
    normal = build_fixture(
        "2026-08-03", "normal_week",
        "First week after the rest-week rollout backlog clears - no forced "
        "rest expected. Good baseline case: ordinary availability, ordinary "
        "ledger balances, nothing unusual.",
    )
    forced_rest = build_fixture(
        "2026-07-20", "forced_rest_week",
        "Matches the real, already-solved output in rota_view.html (Jamal "
        "Reid and Liam O'Connor resting) - lets us sanity-check the JS "
        "engine's forced-off logic against a known-good real result. "
        "NOTE: existingLedgerBalances here only reflects the 26 weeks of "
        "closed synthetic history, NOT the two solved-but-not-closed weeks "
        "that came before this one (2026-07-06 and 2026-07-13) - because "
        "nothing has ever banked their ledger events. This is a live "
        "demonstration of the ledger-close gap the v2 rebuild fixes.",
    )

    with open(f"{OUT_DIR}/normal_week.json", "w") as f:
        json.dump(normal, f, indent=2)
    with open(f"{OUT_DIR}/forced_rest_week.json", "w") as f:
        json.dump(forced_rest, f, indent=2)

    # infeasible_day.json: constructed, not real - strip all receptionist
    # availability on the Tuesday of the normal week, so no valid coverage
    # is possible that day. Everything else is identical to normal_week.
    infeasible = json.loads(json.dumps(normal))  # deep copy
    infeasible["fixtureLabel"] = "infeasible_day"
    infeasible["notes"] = (
        "CONSTRUCTED, not pulled from real history - there's no naturally "
        "occurring infeasible day in the test data. Built from normal_week "
        "by removing every receptionist's availability on Tuesday 2026-08-04, "
        "so no valid coverage exists that day. Tests that both engines "
        "report the gap visibly instead of silently leaving it blank."
    )
    tuesday = "2026-08-04"
    receptionist_ids = {s["id"] for s in infeasible["staff"] if s["role"] == "receptionist"}
    infeasible["leave"] = infeasible["leave"] + [
        dict(staffId=sid, dateFrom=tuesday, dateTo=tuesday, type="unavailable",
             note="Injected by infeasible_day fixture construction")
        for sid in receptionist_ids
    ]
    with open(f"{OUT_DIR}/infeasible_day.json", "w") as f:
        json.dump(infeasible, f, indent=2)

    print("Fixtures written to app/fixtures/:")
    print(f"  normal_week.json        - {normal['weekStart']} "
          f"(forced off: {normal['forcedOff'] or 'none'})")
    print(f"  forced_rest_week.json   - {forced_rest['weekStart']} "
          f"(forced off: {forced_rest['forcedOff']})")
    print(f"  infeasible_day.json     - built from normal_week, "
          f"Tuesday {tuesday} reception coverage impossible")


if __name__ == "__main__":
    main()
    conn.close()

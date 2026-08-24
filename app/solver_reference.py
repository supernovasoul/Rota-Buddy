"""
JSON-ADAPTED ROTA SOLVER — Phase 2 reference oracle.
=========================================================
This is solve_rota.py's CP-SAT model (same hard rules, same fairness
objective, same tie-breaker — logic is unchanged) rewired to take a JSON
fixture as input and return a JSON result, instead of reading/writing
spa_rota.db. It exists so the new JS engine has something known-correct
to diff against for the Phase 2 equivalence test.

INPUT SHAPE: matches app/fixtures/*.json (produced by
scripts/export_fixtures.py) — staff[], availabilityPatterns[], leave[],
forcedOff[] (already computed — this does NOT recompute the rest-week
rollout logic), existingLedgerBalances (already computed — does NOT
recompute from ledger history), staffDimensionSettings[], demandRule.

WHAT THIS DELIBERATELY DOES NOT COVER — same simplifications as
solve_rota.py, still true here: no treatment-type/qualification matching,
no shift preferences, no 11h rest-between-shifts rule. It ALSO does not
implement anything new in v2 (39h weekly cap, coverage-based reception
hard rule, hours-based reception fairness, WTR warning, priority
weighting) — those have no Python equivalent, so they're the JS engine's
own hand-verified test scenarios, not something this oracle can check.
See app/data-model.md for what's new and scripts/export_fixtures.py for
the fixture-generation side of this.

Usage:
    python3 app/solver_reference.py app/fixtures/normal_week.json
    python3 app/solver_reference.py app/fixtures/normal_week.json --out app/fixtures/normal_week.solved.json

Can also be imported directly: from solver_reference import solve
"""

import argparse
import json
import sys
from datetime import date, timedelta
from ortools.sat.python import cp_model

SCALE = 100
MAX_HOURS_PER_DAY = 8
FAIRNESS_SHIFT_DIMS = {"early": "REC_EARLY", "late": "REC_LATE"}
SHIFT_TIMES = {"early": ("08:00", "14:00"), "late": ("14:00", "20:00")}


def solve(fixture):
    week_start = date.fromisoformat(fixture["weekStart"])
    week_end = date.fromisoformat(
        fixture.get("weekEnd") or (week_start + timedelta(days=6)).isoformat()
    )

    staff = fixture["staff"]
    receptionists = [s for s in staff if s["role"] == "receptionist"]
    therapists = [s for s in staff if s["role"] == "therapist"]
    names = {s["id"]: s["name"] for s in staff}
    start_dates = {s["id"]: s["startDate"] for s in staff}
    forced_off = set(fixture.get("forcedOff", []))

    patterns = {}
    for row in fixture.get("availabilityPatterns", []):
        sid = row["staffId"]
        patterns.setdefault(sid, set())
        if row["available"]:
            patterns[sid].add(row["dayOfWeek"])

    leave = {}
    for row in fixture.get("leave", []):
        leave.setdefault(row["staffId"], []).append(
            (date.fromisoformat(row["dateFrom"]), date.fromisoformat(row["dateTo"]))
        )

    def is_available(staff_id, day):
        if staff_id in patterns and day.weekday() not in patterns[staff_id]:
            return False
        for (f, t) in leave.get(staff_id, []):
            if f <= day <= t:
                return False
        return True

    def has_started(staff_id, day):
        return date.fromisoformat(start_dates[staff_id]) <= day

    ledger_balances = fixture.get("existingLedgerBalances", {})

    def existing_balance(staff_id, dim_code):
        return ledger_balances.get(str(staff_id), {}).get(dim_code, 0.0)

    exemptions = {
        (row["staffId"], row["dimensionCode"])
        for row in fixture.get("staffDimensionSettings", [])
        if row["mode"] == "exempt"
    }

    def is_exempt(staff_id, dim_code):
        return (staff_id, dim_code) in exemptions

    demand_rule = fixture.get("demandRule", {"weekdayHours": 20, "weekendHours": 30})

    def demand_for(day):
        return demand_rule["weekendHours"] if day.weekday() >= 5 else demand_rule["weekdayHours"]

    # -----------------------------------------------------------------
    # reception: one shift per slot per day, hard-covered by exactly
    # one eligible person (or left genuinely unfilled if nobody's eligible)
    # -----------------------------------------------------------------
    model = cp_model.CpModel()
    reception_vars = {}
    shift_meta = {}

    for i in range(7):
        day = week_start + timedelta(days=i)
        is_weekend = day.weekday() >= 5
        for slot in ("early", "late"):
            shift_key = (day.isoformat(), slot)
            shift_meta[shift_key] = dict(day=day, slot=slot, is_weekend=is_weekend)

            eligible = [
                s["id"] for s in receptionists
                if has_started(s["id"], day) and is_available(s["id"], day)
                and s["id"] not in forced_off
            ]
            vars_this_shift = []
            for sid in eligible:
                v = model.NewBoolVar(f"x_{sid}_{day}_{slot}")
                reception_vars[(sid, shift_key)] = v
                vars_this_shift.append(v)

            if vars_this_shift:
                model.Add(sum(vars_this_shift) == 1)
            # else: no one eligible - shift stays unfilled, reported as a gap below

    # -----------------------------------------------------------------
    # therapists: hours per person per day, summing to that day's demand
    # -----------------------------------------------------------------
    therapist_hours = {}
    demand_by_day = {}

    for i in range(7):
        day = week_start + timedelta(days=i)
        base = demand_for(day)
        demand_by_day[day.isoformat()] = base

        available_today = [
            s for s in therapists
            if has_started(s["id"], day) and is_available(s["id"], day)
            and s["id"] not in forced_off
        ]
        day_vars = []
        for s in available_today:
            v = model.NewIntVar(0, MAX_HOURS_PER_DAY, f"h_{s['id']}_{day}")
            therapist_hours[(s["id"], day.isoformat())] = v
            day_vars.append(v)

        if day_vars:
            capacity = len(day_vars) * MAX_HOURS_PER_DAY
            target = min(base, capacity)
            model.Add(sum(day_vars) == target)

    # -----------------------------------------------------------------
    # fairness objective: minimise total deviation from zero, per
    # dimension, using the existing ledger balance as the starting point
    # -----------------------------------------------------------------
    objective_terms = []

    for s in receptionists:
        sid = s["id"]
        for slot, dim_code in FAIRNESS_SHIFT_DIMS.items():
            if is_exempt(sid, dim_code):
                continue
            shifts_this_dim = [
                k for k in shift_meta
                if shift_meta[k]["slot"] == slot and (sid, k) in reception_vars
            ]
            if not shifts_this_dim:
                continue
            actual_expr = sum(reception_vars[(sid, k)] for k in shifts_this_dim)
            fair_share = sum(
                1.0 / sum(1 for (s2, k2) in reception_vars if k2 == k)
                for k in shifts_this_dim
            )
            existing_scaled = round(existing_balance(sid, dim_code) * SCALE)
            fair_share_scaled = round(fair_share * SCALE)
            projected = existing_scaled + SCALE * actual_expr - fair_share_scaled
            dev_pos = model.NewIntVar(0, 100000, f"devpos_{sid}_{dim_code}")
            dev_neg = model.NewIntVar(0, 100000, f"devneg_{sid}_{dim_code}")
            model.Add(dev_pos - dev_neg == projected)
            objective_terms.extend([dev_pos, dev_neg])

        if not is_exempt(sid, "REC_WEEKEND"):
            weekend_shifts = [
                k for k in shift_meta
                if shift_meta[k]["is_weekend"] and (sid, k) in reception_vars
            ]
            if weekend_shifts:
                actual_expr = sum(reception_vars[(sid, k)] for k in weekend_shifts)
                fair_share = sum(
                    1.0 / sum(1 for (s2, k2) in reception_vars if k2 == k)
                    for k in weekend_shifts
                )
                existing_scaled = round(existing_balance(sid, "REC_WEEKEND") * SCALE)
                fair_share_scaled = round(fair_share * SCALE)
                projected = existing_scaled + SCALE * actual_expr - fair_share_scaled
                dev_pos = model.NewIntVar(0, 100000, f"devpos_{sid}_weekend")
                dev_neg = model.NewIntVar(0, 100000, f"devneg_{sid}_weekend")
                model.Add(dev_pos - dev_neg == projected)
                objective_terms.extend([dev_pos, dev_neg])

    for s in therapists:
        sid, frac = s["id"], s["proportionalFraction"]
        days_available = [
            week_start + timedelta(days=i) for i in range(7)
            if (sid, (week_start + timedelta(days=i)).isoformat()) in therapist_hours
        ]
        if not days_available:
            continue
        actual_expr = sum(therapist_hours[(sid, d.isoformat())] for d in days_available)

        entitled_hours = 0.0
        for d in days_available:
            base = demand_for(d)
            pool = [
                s2 for s2 in therapists
                if has_started(s2["id"], d) and is_available(s2["id"], d)
                and s2["id"] not in forced_off
            ]
            total_frac = sum(s2["proportionalFraction"] for s2 in pool) or 1.0
            entitled_hours += base * (frac / total_frac)

        existing_scaled = round(existing_balance(sid, "THER_HOURS") * SCALE)
        entitled_scaled = round(entitled_hours * SCALE)
        projected = existing_scaled + SCALE * actual_expr - entitled_scaled
        dev_pos = model.NewIntVar(0, 1000000, f"devpos_{sid}_hours")
        dev_neg = model.NewIntVar(0, 1000000, f"devneg_{sid}_hours")
        model.Add(dev_pos - dev_neg == projected)
        objective_terms.extend([dev_pos, dev_neg])

    model.Minimize(sum(objective_terms))

    # tie-breaker: prefer spreading shifts evenly across people when two
    # allocations are otherwise equally fair (see solve_rota.py STEP 7b)
    for s in receptionists:
        sid = s["id"]
        relevant_vars = [v for (s2, k), v in reception_vars.items() if s2 == sid]
        if not relevant_vars:
            continue
        total_var = model.NewIntVar(0, len(relevant_vars), f"total_{sid}")
        model.Add(total_var == sum(relevant_vars))
        sq_var = model.NewIntVar(0, len(relevant_vars) ** 2, f"sq_{sid}")
        model.AddMultiplicationEquality(sq_var, [total_var, total_var])
        objective_terms.append(sq_var)

    model.Minimize(sum(objective_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 15
    solver.parameters.num_search_workers = 8
    status = solver.Solve(model)
    status_name = solver.StatusName(status)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {
            "fixtureLabel": fixture.get("fixtureLabel"),
            "weekStart": week_start.isoformat(),
            "weekEnd": week_end.isoformat(),
            "status": status_name,
            "objectiveValue": None,
            "receptionAssignments": [],
            "therapistAssignments": [],
            "demand": [{"date": d, "hours": h} for d, h in sorted(demand_by_day.items())],
        }

    reception_assignments = []
    for i in range(7):
        day = week_start + timedelta(days=i)
        for slot in ("early", "late"):
            key = (day.isoformat(), slot)
            start_t, end_t = SHIFT_TIMES[slot]
            assigned = [
                sid for (sid, k) in reception_vars
                if k == key and solver.Value(reception_vars[(sid, k)]) == 1
            ]
            reception_assignments.append({
                "date": day.isoformat(),
                "slot": slot,
                "startTime": start_t,
                "endTime": end_t,
                "staffId": assigned[0] if assigned else None,
                "staffName": names[assigned[0]] if assigned else None,
                "unfilled": not assigned,
            })

    therapist_assignments = []
    for (sid, d), v in therapist_hours.items():
        hrs = solver.Value(v)
        if hrs > 0:
            therapist_assignments.append({
                "date": d, "staffId": sid, "staffName": names[sid], "hours": hrs,
            })
    therapist_assignments.sort(key=lambda r: (r["date"], r["staffId"]))

    return {
        "fixtureLabel": fixture.get("fixtureLabel"),
        "weekStart": week_start.isoformat(),
        "weekEnd": week_end.isoformat(),
        "status": status_name,
        "objectiveValue": solver.ObjectiveValue(),
        "receptionAssignments": reception_assignments,
        "therapistAssignments": therapist_assignments,
        "demand": [{"date": d, "hours": h} for d, h in sorted(demand_by_day.items())],
    }


def main():
    parser = argparse.ArgumentParser(
        description="Solve a rota from a JSON fixture (Phase 2 reference oracle)."
    )
    parser.add_argument("fixture", help="Path to input fixture JSON (see app/fixtures/)")
    parser.add_argument("--out", help="Path to write solved output JSON (default: stdout only)")
    args = parser.parse_args()

    with open(args.fixture) as f:
        fixture = json.load(f)

    result = solve(fixture)

    if args.out:
        with open(args.out, "w") as f:
            json.dump(result, f, indent=2)
        print(f"Solved. Status: {result['status']}. Written to {args.out}", file=sys.stderr)
    else:
        json.dump(result, sys.stdout, indent=2)
        print()


if __name__ == "__main__":
    main()

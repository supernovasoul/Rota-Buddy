"""
ROTA VIEWER
===========
Turns the most recently solved week (from solve_rota.py) into an
actual HTML page you can open in any web browser - a proper visual
rota, instead of reading raw text in the terminal.

This is READ-ONLY: it doesn't change anything in the database, it
just draws a picture of what's already there.

Run with:   python3 generate_rota_view.py
Then open the file it creates (rota_view.html) by double-clicking
it, or dragging it into a browser window.
"""

import sqlite3
from datetime import date, timedelta

DB_FILE = "spa_rota.db"
OUTPUT_FILE = "rota_view.html"

conn = sqlite3.connect(DB_FILE)

# -----------------------------------------------------------------
# STEP 1: find the most recently solved (published) week
# -----------------------------------------------------------------
period = conn.execute(
    """SELECT id, start_date, end_date FROM rota_periods
       WHERE status = 'published' ORDER BY start_date DESC LIMIT 1"""
).fetchone()

if not period:
    print("No published rota found yet - run solve_rota.py first.")
    conn.close()
    raise SystemExit

period_id, start_date, end_date = period
week_start = date.fromisoformat(start_date)
days = [week_start + timedelta(days=i) for i in range(7)]

# -----------------------------------------------------------------
# STEP 2: who's resting this week (from the rollout plan)
# -----------------------------------------------------------------
resting = [row[0] for row in conn.execute(
    """SELECT s.name FROM planned_rest_weeks p JOIN staff s ON s.id = p.staff_id
       WHERE p.week_start = ? AND p.status IN ('planned', 'taken')""",
    (start_date,),
)]

# -----------------------------------------------------------------
# STEP 3: reception rota - who's on early/late each day
# -----------------------------------------------------------------
reception_grid = {}   # (date_iso, slot) -> name
for date_iso, slot, name in conn.execute(
    """SELECT sh.date, CASE WHEN sh.is_early = 1 THEN 'early' ELSE 'late' END, s.name
       FROM shifts sh
       JOIN assignments a ON a.shift_id = sh.id
       JOIN staff s ON s.id = a.staff_id
       WHERE sh.period_id = ? AND sh.role_required = 'receptionist'""",
    (period_id,),
):
    reception_grid[(date_iso, slot)] = name

# -----------------------------------------------------------------
# STEP 4: therapist hours - who's working each day and for how long
# -----------------------------------------------------------------
therapist_grid = {}   # date_iso -> list of (name, hours)
for date_iso, name in conn.execute(
    """SELECT sh.date, s.name
       FROM shifts sh
       JOIN assignments a ON a.shift_id = sh.id
       JOIN staff s ON s.id = a.staff_id
       WHERE sh.period_id = ? AND sh.role_required = 'therapist'
       ORDER BY sh.date, s.name""",
    (period_id,),
):
    therapist_grid.setdefault(date_iso, []).append(name)

# each therapist shift row represents roughly 8 hours in our current
# model (one shift = one day's hours block) - shown as a simple tally
# rather than a precise hour count, since that's what's actually
# stored per shift row at this stage of the build
therapist_hours = {}  # date_iso -> {name: shift_count}
for date_iso, names in therapist_grid.items():
    therapist_hours[date_iso] = {}
    for n in names:
        therapist_hours[date_iso][n] = therapist_hours[date_iso].get(n, 0) + 1

# -----------------------------------------------------------------
# STEP 5: fairness snapshot (rolling balances, current staff)
# -----------------------------------------------------------------
fairness_rows = conn.execute(
    """SELECT s.name, fd.code,
              ROUND(SUM(le.actual - le.entitled), 1) AS balance,
              CASE WHEN sds.mode = 'exempt' THEN 1 ELSE 0 END AS exempt
       FROM ledger_events le
       JOIN staff s ON s.id = le.staff_id
       JOIN fairness_dimensions fd ON fd.id = le.dimension_id
       JOIN rota_periods rp ON rp.id = le.period_id
       LEFT JOIN staff_dimension_settings sds
              ON sds.staff_id = s.id AND sds.dimension_id = fd.id
       WHERE rp.start_date >= DATE(?, '-91 days') AND s.end_date IS NULL
       GROUP BY s.name, fd.code
       ORDER BY fd.code, balance DESC""",
    (start_date,),
).fetchall()

conn.close()

# -----------------------------------------------------------------
# STEP 6: build the HTML
# -----------------------------------------------------------------
DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def cell(text, muted=False, weekend=False):
    cls = []
    if muted:
        cls.append("muted")
    if weekend:
        cls.append("weekend")
    cls_attr = f' class="{" ".join(cls)}"' if cls else ""
    return f"<td{cls_attr}>{text}</td>"


reception_rows_html = ""
for slot_label, slot_key in [("Early (08:00–14:00)", "early"), ("Late (14:00–20:00)", "late")]:
    row = f"<tr><th>{slot_label}</th>"
    for d in days:
        name = reception_grid.get((d.isoformat(), slot_key))
        weekend = d.weekday() >= 5
        row += cell(name if name else "—", muted=(name is None), weekend=weekend)
    row += "</tr>"
    reception_rows_html += row

all_therapist_names = sorted({n for names in therapist_grid.values() for n in names})
therapist_rows_html = ""
for name in all_therapist_names:
    row = f"<tr><th>{name}</th>"
    for d in days:
        count = therapist_hours.get(d.isoformat(), {}).get(name, 0)
        weekend = d.weekday() >= 5
        row += cell(f"{count} shift{'s' if count != 1 else ''}" if count else "—",
                     muted=(count == 0), weekend=weekend)
    row += "</tr>"
    therapist_rows_html += row

resting_html = ""
if resting:
    names_list = ", ".join(resting)
    resting_html = f"""
    <div class="banner">
        Resting this week (mandatory rest-week rule): <strong>{names_list}</strong>
    </div>"""

fairness_html = ""
current_dim = None
for name, dim, balance, exempt in fairness_rows:
    if dim != current_dim:
        if current_dim is not None:
            fairness_html += "</tbody></table>"
        fairness_html += f"<h3>{dim}</h3><table class='fairness'><tbody>"
        current_dim = dim
    balance_class = "positive" if balance > 0 else ("negative" if balance < 0 else "")
    exempt_tag = " <span class='tag'>EXEMPT</span>" if exempt else ""
    sign = "+" if balance > 0 else ""
    fairness_html += (
        f"<tr><td>{name}{exempt_tag}</td>"
        f"<td class='{balance_class}'>{sign}{balance}</td></tr>"
    )
if current_dim is not None:
    fairness_html += "</tbody></table>"

day_headers = "".join(
    f"<th class='{'weekend' if d.weekday() >= 5 else ''}'>{DAY_NAMES[i]}<br>"
    f"<span class='date'>{d.strftime('%d %b')}</span></th>"
    for i, d in enumerate(days)
)

html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Spa Rota — week of {week_start.strftime('%d %b %Y')}</title>
<style>
    body {{
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: #f5f3f0;
        color: #2b2b2b;
        margin: 0;
        padding: 40px 24px;
    }}
    .container {{ max-width: 960px; margin: 0 auto; }}
    h1 {{ font-size: 1.6rem; font-weight: 600; margin-bottom: 4px; }}
    .subtitle {{ color: #6b6b6b; margin-bottom: 28px; }}
    .banner {{
        background: #fff4e5; border: 1px solid #f0c896; color: #7a4a10;
        padding: 12px 16px; border-radius: 8px; margin-bottom: 24px; font-size: 0.95rem;
    }}
    section {{ margin-bottom: 36px; }}
    h2 {{ font-size: 1.1rem; font-weight: 600; margin-bottom: 12px; color: #3a3a3a; }}
    table {{
        width: 100%; border-collapse: collapse; background: white;
        border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    }}
    th, td {{ padding: 10px 12px; text-align: center; border-bottom: 1px solid #eee; font-size: 0.9rem; }}
    th {{ background: #ece7e0; font-weight: 600; color: #4a4a4a; }}
    th:first-child, td:first-child {{ text-align: left; font-weight: 500; }}
    .date {{ font-weight: 400; color: #8a8a8a; font-size: 0.75rem; }}
    .weekend {{ background: #f7f2ea; }}
    .muted {{ color: #b8b8b8; }}
    .fairness {{ margin-bottom: 20px; }}
    .fairness td:first-child {{ width: 60%; }}
    .positive {{ color: #b0631f; font-weight: 600; }}
    .negative {{ color: #2a7a5c; font-weight: 600; }}
    .tag {{
        font-size: 0.7rem; background: #e0ece5; color: #2a7a5c;
        padding: 2px 6px; border-radius: 4px; margin-left: 4px;
    }}
    .legend {{ font-size: 0.8rem; color: #8a8a8a; margin-top: 6px; }}
</style>
</head>
<body>
<div class="container">
    <h1>Spa Rota</h1>
    <div class="subtitle">Week of {week_start.strftime('%d %B %Y')} – {days[-1].strftime('%d %B %Y')}</div>

    {resting_html}

    <section>
        <h2>Reception</h2>
        <table>
            <tr><th></th>{day_headers}</tr>
            {reception_rows_html}
        </table>
    </section>

    <section>
        <h2>Therapists</h2>
        <table>
            <tr><th></th>{day_headers}</tr>
            {therapist_rows_html}
        </table>
        <div class="legend">Each "shift" is roughly a full working day's treatment hours.</div>
    </section>

    <section>
        <h2>Fairness snapshot (rolling 13-week balance)</h2>
        <div class="legend">
            <span class="positive">Orange</span> = had more than their fair share &nbsp;·&nbsp;
            <span class="negative">Green</span> = owed more &nbsp;·&nbsp;
            near zero = balanced
        </div>
        {fairness_html}
    </section>
</div>
</body>
</html>"""

with open(OUTPUT_FILE, "w") as f:
    f.write(html)

print(f"Rota view saved as {OUTPUT_FILE}")
print("Open it by double-clicking the file, or dragging it into a browser window.")

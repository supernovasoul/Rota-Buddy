# RotaFable — Completion Prompt (v2)

## Context
I manage a small spa team (reception + therapists) and have built a working rota system called RotaFable. **Important — read this carefully before touching anything:** the system is NOT a single HTML file. It is a set of Python scripts and a SQLite database:

- `schema.sql` / `spa_rota.db` — the data model (staff, shifts, periods, fairness ledger)
- `solve_rota.py` — the fairness engine. Uses OR-Tools CP-SAT to allocate shifts. **This file is the source of truth for all rota logic.**
- `plan_rest_rollout.py` — schedules each staff member's mandatory rest weeks across upcoming periods
- `generate_synthetic_data.py` — creates realistic fake staff/demand data for testing
- `generate_rota_view.py` → `rota_view.html` — a display layer only. The HTML contains **no logic**; do not treat it as the app.

Start by reading ALL of these files and telling me, in plain English, what the system currently does — including the fairness rules you find in `solve_rota.py` — before proposing anything. I will confirm or correct your understanding before you write code.

## Goal
Turn RotaFable into a complete, polished, distributable rota app that I can use monthly at my own spa and sell to other spa managers (one-time purchase via Gumroad).

## The architecture question (answer this first)
The target deliverable is a self-contained HTML file that runs entirely in the browser with no install. The current solver is Python + OR-Tools, which cannot run in a browser. This means the fairness engine must be **reimplemented in JavaScript**. Before building, tell me:

- (a) How you propose to reimplement the solver logic in JS (library, or a custom heuristic/search) and what trade-offs that involves
- (b) How we will **prove equivalence**: the JS engine must be validated against the Python solver on the same synthetic test data, producing rotas that satisfy all the same hard constraints with comparable fairness scores. Define this test before writing the JS engine.

Do not simplify the fairness logic to make the port easier. The full rule set — hours-based proportional allocation, the rolling 13-week fairness ledger, constrained-days-first allocation, weekly hour caps, per-staff special rules, and mandatory rest-week rollout — must survive the port intact. If any rule genuinely cannot be ported, stop and tell me which one and why; do not silently drop it.

## Scope — what "complete" means
1. **Availability input** — a simple form/grid to enter each staff member's availability for the month. No spreadsheet pasting.
2. **Demand input** — therapist hours track treatment demand. The manager needs a simple way to enter expected demand (e.g. required therapist-hours per day, or a per-day busy/normal/quiet setting that maps to hours). Propose the simplest input that preserves the current demand-driven behaviour.
3. **Rota generation** — apply the full fairness logic to produce the month's rota. Clarify with me whether a "month" is solved as four/five linked weeks (matching the current weekly solver) or one block, and what the trade-offs are.
4. **Rest weeks** — the rest-week rollout must be part of the app: the manager can see who is due a rest week and the generator honours the plan.
5. **Manual editing** — I can override any generated shift, with the fairness tracker updating live and warnings if an edit breaks a hard rule (e.g. exceeds a weekly cap).
6. **Infeasibility handling** — if no valid rota exists for a day/week, the app must say so visibly and explain the likely cause (e.g. "not enough available reception staff on Tuesday"), never silently leave blanks.
7. **Persistence** — save and reload rotas and settings locally (browser localStorage plus export/import to a file, so data survives a cleared browser). Saved data carries a schema version number so future app versions can migrate old data.
8. **Export** — printable view (proper print CSS), CSV export, and a proper Excel (.xlsx) export laid out like a traditional rota grid (days across the top, staff down the side), so the rota can be re-entered into SharePoint, opened directly in Excel, or shared with staff. Also include per-person schedules: a one-click, clean printable page per staff member showing only their own shifts for the month, suitable for printing or sharing as an image.

## Configurability (critical)
Other spas have different rules. Do NOT hard-code my shift times, staff list, or fairness exceptions. Build a settings area where a manager can define:
- Staff members, roles, and special rules (locked patterns, priority allocation, fairness exemptions, cross-cover between roles, rest-week eligibility)
- Shift types with start/end times and paid hours
- Weekly hour caps, closure dates, and demand defaults

My current rules ship as the default example configuration using placeholder codes (T1–T7, R1–R5) — never real names, and never the synthetic names from testing.

## Security & data protection
- The app handles staff names and working hours — treat this as personal data under UK GDPR.
- All data stays local (localStorage or exported files). No analytics, no external calls, no fonts/scripts loaded from the internet — the file must work fully offline.
- Sanitise all user input; review every place user-entered text is rendered for XSS risks.
- Include a "clear all data" option, and state in the README exactly where data lives.

## UX
- Clean, calm, professional — suitable for a non-technical spa manager.
- Mobile-usable for viewing; desktop for editing.
- Clear empty states and error messages. A missing shift is a flagged warning, never a silent blank.
- Fix known display issues: an exempt staff member should not show a fairness balance value; therapist shifts need shift-length distinction (a 4-hour and an 8-hour day must look different).

## Distribution
Sold as a one-time download, so the deliverable is a self-contained product:
- One HTML file that opens in any modern browser — no install, no setup, no internet.
- A short plain-English README (PDF or second HTML page): getting started, configuring staff and shift rules, how data stays private, how to back up/restore via export files.
- A version number visible in the app.
- First-run experience: a guided setup walking a new manager through creating their staff and shifts, with my example configuration available as a copyable template.
- Confirm there are no licensing issues with any JS library you use in a product sold commercially, and list the licences in the README.

## Working method
- Before writing any code, give me: (a) your plain-English assessment of the current system, rule by rule; (b) your answer to the architecture question above; (c) a phased build plan with the solver-equivalence test as its own early phase; (d) any questions. Wait for my approval.
- Work one phase at a time. Show me each phase working before moving on.
- I set up tools confidently but don't have underlying coding knowledge — explain what you're doing and why in plain terms as you go, not just what commands to run.

## Post-launch roadmap (do NOT build these now)
These are planned future updates. Do not include them in the current build, but don't design anything that would make them hard to add later:
1. **v1.1 — Swap assistant:** when someone calls in sick, a "find cover" button ranks available staff by who it would be fairest to ask, respecting caps and rest weeks.
2. **"Why this shift?" explanations:** click any allocated shift to see the reasoning in plain English (fairness balance, availability, rules applied).
3. **Fairness report:** a quarterly per-person summary — weekends, late shifts, total hours vs contracted share — printable for one-to-ones.
4. **Leave planning:** annual leave entry with at-booking warnings when approving leave would make a future week hard to cover.

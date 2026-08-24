-- ============================================================
-- SPA ROTA SYSTEM — DATABASE SCHEMA
-- ============================================================
-- This file doesn't contain any data. It's a set of
-- instructions that tells SQLite what tables to create and
-- what rules each column must follow. Think of it as the
-- blueprint for an empty filing cabinet: it defines the
-- drawers and their labels, but nothing is filed yet.
--
-- Lines starting with "--" are comments: notes for humans,
-- ignored by the database.
-- ============================================================

-- Enforce relationships between tables (e.g. an assignment
-- must point at a real shift). Off by default in SQLite,
-- so we switch it on.
PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- STAFF: one row per person, ever employed.
-- ------------------------------------------------------------
CREATE TABLE staff (
    id                    INTEGER PRIMARY KEY,  -- unique number auto-given to each person
    name                  TEXT NOT NULL,
    role                  TEXT NOT NULL CHECK (role IN ('receptionist', 'therapist')),
    start_date            TEXT NOT NULL,        -- dates stored as 'YYYY-MM-DD'
    end_date              TEXT,                 -- empty (NULL) = still employed
    proportional_fraction REAL,                 -- therapists only, e.g. 0.5 = half share
    contracted_hours_min  REAL,                 -- receptionists only
    contracted_hours_max  REAL,                 -- receptionists only
    -- 'flex' = no fixed weekly pattern; by contract terms they must get
    -- at least one full shift-free week every rolling 13 weeks, so they
    -- aren't effectively operating as if on a fixed contract.
    -- Stored explicitly (not inferred from patterns) because it's a
    -- contractual fact, not a scheduling coincidence.
    employment_type       TEXT NOT NULL DEFAULT 'fixed_pattern'
                          CHECK (employment_type IN ('fixed_pattern', 'flex'))
);

-- ------------------------------------------------------------
-- QUALIFICATIONS: treatment types a therapist can be trained in.
-- staff_qualifications links people to qualifications
-- (a "join table": each row = one person holds one qualification).
-- ------------------------------------------------------------
CREATE TABLE qualifications (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE staff_qualifications (
    staff_id         INTEGER NOT NULL REFERENCES staff(id),
    qualification_id INTEGER NOT NULL REFERENCES qualifications(id),
    PRIMARY KEY (staff_id, qualification_id)    -- same pair can't appear twice
);

-- ------------------------------------------------------------
-- ROTA PERIODS: one row per rota week.
-- The ledger only ever writes when a period is 'closed',
-- so drafts can be re-solved endlessly without polluting history.
-- ------------------------------------------------------------
CREATE TABLE rota_periods (
    id         INTEGER PRIMARY KEY,
    start_date TEXT NOT NULL,
    end_date   TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'published', 'closed'))
);

-- ------------------------------------------------------------
-- SHIFTS: a slot of work that needs filling.
-- Weekend is NOT stored — it's calculated from the date,
-- so it can never be wrong.
-- ------------------------------------------------------------
CREATE TABLE shifts (
    id              INTEGER PRIMARY KEY,
    period_id       INTEGER NOT NULL REFERENCES rota_periods(id),
    date            TEXT NOT NULL,
    start_time      TEXT NOT NULL,              -- 'HH:MM'
    end_time        TEXT NOT NULL,
    role_required   TEXT NOT NULL CHECK (role_required IN ('receptionist', 'therapist')),
    treatment_type  TEXT,                       -- therapist shifts only, may be NULL
    is_early        INTEGER NOT NULL DEFAULT 0, -- SQLite has no true/false; 1 = yes, 0 = no
    is_late         INTEGER NOT NULL DEFAULT 0,
    is_bank_holiday INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------------------------------------
-- ASSIGNMENTS: who is doing which shift.
-- 'locked' = the solver must not change this row when
-- re-solving (e.g. after a sick call mid-week).
-- ------------------------------------------------------------
CREATE TABLE assignments (
    id       INTEGER PRIMARY KEY,
    shift_id INTEGER NOT NULL REFERENCES shifts(id),
    staff_id INTEGER NOT NULL REFERENCES staff(id),
    status   TEXT NOT NULL DEFAULT 'assigned'
             CHECK (status IN ('assigned', 'worked', 'reassigned_away')),
    locked   INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------------------------------------
-- AVAILABILITY PATTERNS: recurring weekly availability.
-- "Tues/Thurs only" lives here, entered once.
-- day_of_week: 0 = Monday ... 6 = Sunday.
-- ------------------------------------------------------------
CREATE TABLE availability_patterns (
    id          INTEGER PRIMARY KEY,
    staff_id    INTEGER NOT NULL REFERENCES staff(id),
    day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    available   INTEGER NOT NULL DEFAULT 1
);

-- ------------------------------------------------------------
-- AVAILABILITY: one-off exceptions to the pattern.
-- The 'type' is what the edge-case logic keys off:
--   holiday / sick / unavailable  -> pro-rate entitlement
--   preference_off / preference_on -> soft wish, ledger untouched
-- ------------------------------------------------------------
CREATE TABLE availability (
    id        INTEGER PRIMARY KEY,
    staff_id  INTEGER NOT NULL REFERENCES staff(id),
    date_from TEXT NOT NULL,
    date_to   TEXT NOT NULL,
    type      TEXT NOT NULL CHECK (type IN
              ('holiday', 'sick', 'unavailable', 'preference_off', 'preference_on')),
    granted   INTEGER NOT NULL DEFAULT 1,
    note      TEXT
);

-- ------------------------------------------------------------
-- DEMAND: forecast therapist hours needed per day.
-- override_hours wins when present ("I know a promo is running").
-- ------------------------------------------------------------
CREATE TABLE demand (
    id             INTEGER PRIMARY KEY,
    date           TEXT NOT NULL,
    treatment_type TEXT,
    forecast_hours REAL NOT NULL,
    override_hours REAL
);

-- ------------------------------------------------------------
-- FAIRNESS DIMENSIONS: the things fairness is measured in.
-- A lookup table — adding a new fairness rule later is one
-- new row here, not a schema change.
-- ------------------------------------------------------------
CREATE TABLE fairness_dimensions (
    id          INTEGER PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    role        TEXT NOT NULL CHECK (role IN ('receptionist', 'therapist')),
    description TEXT NOT NULL
);

-- ------------------------------------------------------------
-- STAFF DIMENSION SETTINGS: the explicit override switch.
-- Only needs a row when someone deviates from the default.
-- 'exempt' = doesn't accrue balance on this dimension AND
-- isn't counted in anyone else's fair share.
-- The note is what makes the exemption defensible later.
-- ------------------------------------------------------------
CREATE TABLE staff_dimension_settings (
    id           INTEGER PRIMARY KEY,
    staff_id     INTEGER NOT NULL REFERENCES staff(id),
    dimension_id INTEGER NOT NULL REFERENCES fairness_dimensions(id),
    mode         TEXT NOT NULL CHECK (mode IN ('participate', 'exempt')),
    note         TEXT,
    UNIQUE (staff_id, dimension_id)
);

-- ------------------------------------------------------------
-- LEDGER EVENTS: the heart of the system. Append-only —
-- rows are never edited or deleted. Corrections are new
-- 'adjustment' rows, like an accountant's ledger.
-- ------------------------------------------------------------
CREATE TABLE ledger_events (
    id           INTEGER PRIMARY KEY,
    staff_id     INTEGER NOT NULL REFERENCES staff(id),
    dimension_id INTEGER NOT NULL REFERENCES fairness_dimensions(id),
    period_id    INTEGER NOT NULL REFERENCES rota_periods(id),
    entitled     REAL NOT NULL,
    actual       REAL NOT NULL,
    event_type   TEXT NOT NULL CHECK (event_type IN ('period_close', 'adjustment')),
    note         TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- REVENUE: thin for now; grows in the tracking module.
-- ------------------------------------------------------------
CREATE TABLE revenue (
    id     INTEGER PRIMARY KEY,
    date   TEXT NOT NULL,
    stream TEXT NOT NULL CHECK (stream IN ('treatment', 'thermal')),
    amount REAL NOT NULL
);

-- ------------------------------------------------------------
-- Seed the fairness dimensions (reference data, not staff data,
-- so it's safe to live in the schema file).
-- ------------------------------------------------------------
INSERT INTO fairness_dimensions (code, role, description) VALUES
    ('THER_HOURS',      'therapist',    'Hours delivered vs proportional entitlement'),
    ('THER_HIGH_VALUE', 'therapist',    'High-value treatment slots vs fair share'),
    ('REC_WEEKEND',     'receptionist', 'Weekend shifts vs fair share of eligible pool'),
    ('REC_EARLY',       'receptionist', 'Early shifts vs fair share of eligible pool'),
    ('REC_LATE',        'receptionist', 'Late shifts vs fair share of eligible pool'),
    ('REC_BANK_HOL',    'receptionist', 'Bank holiday shifts vs fair share of eligible pool');

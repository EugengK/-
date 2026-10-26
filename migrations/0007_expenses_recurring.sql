-- 지출 + 고정 지출.
-- The expenses tables from 0001 were never written to by the app, so they are rebuilt with:
-- optional department (fixed costs like rent belong to no department), a 'planned' status for
-- scheduled fixed costs, and a link to the fixed-cost rule that produced the row.

DROP TABLE expense_items;
DROP TABLE expenses;

CREATE TABLE recurring_expenses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,                      -- e.g. 담임목사 사례비, 예배당 렌트비
  vendor        TEXT,                               -- payee
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  account       TEXT NOT NULL CHECK (account IN ('cash', 'bank')),
  department_id INTEGER REFERENCES departments (id),
  category_id   INTEGER REFERENCES expense_categories (id),
  -- monthly_day: day_of_month (31 = last day); monthly_weekday: nth (1-4, 5 = last) + weekday (0 = Sunday);
  -- weekly: weekday; fortnightly: every 14 days from anchor_date.
  rule          TEXT NOT NULL CHECK (rule IN ('monthly_day', 'monthly_weekday', 'weekly', 'fortnightly')),
  day_of_month  INTEGER CHECK (day_of_month BETWEEN 1 AND 31),
  nth           INTEGER CHECK (nth BETWEEN 1 AND 5),
  weekday       INTEGER CHECK (weekday BETWEEN 0 AND 6),
  anchor_date   TEXT CHECK (anchor_date IS NULL OR date(anchor_date) IS anchor_date),
  start_date    TEXT NOT NULL CHECK (date(start_date) IS start_date),
  end_date      TEXT CHECK (end_date IS NULL OR (date(end_date) IS end_date AND end_date >= start_date)),
  note          TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_by    INTEGER NOT NULL REFERENCES users (id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- status: planned = scheduled fixed cost not yet paid; draft = filled in by OCR, unchecked;
-- confirmed = paid; void = cancelled/skipped (kept, with reason).
CREATE TABLE expenses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_date  TEXT NOT NULL CHECK (expense_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(expense_date) IS expense_date),
  vendor        TEXT NOT NULL,
  department_id INTEGER REFERENCES departments (id),
  category_id   INTEGER REFERENCES expense_categories (id),
  total_cents   INTEGER NOT NULL CHECK (total_cents > 0),
  gst_cents     INTEGER NOT NULL DEFAULT 0 CHECK (gst_cents >= 0 AND gst_cents <= total_cents),
  account       TEXT NOT NULL CHECK (account IN ('cash', 'bank')),
  paid_by       TEXT,
  note          TEXT,
  image_key     TEXT,
  status        TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('planned', 'draft', 'confirmed', 'void')),
  void_reason   TEXT,
  recurring_id  INTEGER REFERENCES recurring_expenses (id),
  created_by    INTEGER NOT NULL REFERENCES users (id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX expenses_date ON expenses (expense_date);
CREATE INDEX expenses_department ON expenses (department_id, expense_date);
-- One row per fixed cost per date, even if skipped (void), so it is never generated twice.
CREATE UNIQUE INDEX expenses_recurring_once ON expenses (recurring_id, expense_date) WHERE recurring_id IS NOT NULL;

CREATE TABLE expense_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id   INTEGER NOT NULL REFERENCES expenses (id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  quantity     REAL NOT NULL DEFAULT 1 CHECK (quantity > 0),
  amount_cents INTEGER NOT NULL
);
CREATE INDEX expense_items_expense ON expense_items (expense_id);

-- Attributes the automatic "planned" rows in the audit log. Inactive: can never log in.
INSERT INTO users (email, name, role, is_active) VALUES ('scheduler@system.local', '고정 지출 자동 등록', 'viewer', 0);

-- Church accounting schema, v1.
-- Money is stored as integer cents (AUD). Dates are 'YYYY-MM-DD' text.
-- Rows are never deleted by the app: lookups get is_active=0, records get status='void'.

CREATE TABLE users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT,
  email      TEXT,
  note       TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE fund_types (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE departments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE expense_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

-- Church fiscal year = calendar year, so fiscal_year is the calendar year.
-- category_id NULL means a budget for the whole department.
CREATE TABLE budgets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  fiscal_year   INTEGER NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2100),
  department_id INTEGER NOT NULL REFERENCES departments (id),
  category_id   INTEGER REFERENCES expense_categories (id),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX budgets_unique_scope
  ON budgets (fiscal_year, department_id, IFNULL(category_id, 0));

-- member_id NULL = giver not identified (e.g. plain Sunday offering).
-- method: 'cash' goes to the cash account, 'online' to the bank account.
CREATE TABLE offerings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  offering_date TEXT NOT NULL CHECK (offering_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(offering_date) IS offering_date),
  fund_type_id  INTEGER NOT NULL REFERENCES fund_types (id),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  method        TEXT NOT NULL CHECK (method IN ('cash', 'online')),
  member_id     INTEGER REFERENCES members (id),
  note          TEXT,
  image_key     TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  void_reason   TEXT,
  created_by    INTEGER NOT NULL REFERENCES users (id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX offerings_date ON offerings (offering_date);
CREATE INDEX offerings_member ON offerings (member_id, offering_date);

-- status 'draft' = filled in by OCR but not yet confirmed by a person.
-- account: which church account paid ('cash' box or 'bank' account).
CREATE TABLE expenses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_date   TEXT NOT NULL CHECK (expense_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(expense_date) IS expense_date),
  vendor         TEXT NOT NULL,
  department_id  INTEGER NOT NULL REFERENCES departments (id),
  category_id    INTEGER REFERENCES expense_categories (id),
  total_cents    INTEGER NOT NULL CHECK (total_cents > 0),
  gst_cents      INTEGER NOT NULL DEFAULT 0 CHECK (gst_cents >= 0 AND gst_cents <= total_cents),
  account        TEXT NOT NULL CHECK (account IN ('cash', 'bank')),
  paid_by        TEXT,
  note           TEXT,
  image_key      TEXT,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'void')),
  void_reason    TEXT,
  created_by     INTEGER NOT NULL REFERENCES users (id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX expenses_date ON expenses (expense_date);
CREATE INDEX expenses_department ON expenses (department_id, expense_date);

-- amount_cents may be negative (receipt discounts).
CREATE TABLE expense_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id   INTEGER NOT NULL REFERENCES expenses (id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  quantity     REAL NOT NULL DEFAULT 1 CHECK (quantity > 0),
  amount_cents INTEGER NOT NULL
);
CREATE INDEX expense_items_expense ON expense_items (expense_id);

-- One active starting balance per account; correct it by voiding and re-entering.
CREATE TABLE opening_balances (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account      TEXT NOT NULL CHECK (account IN ('cash', 'bank')),
  as_of_date   TEXT NOT NULL CHECK (as_of_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(as_of_date) IS as_of_date),
  amount_cents INTEGER NOT NULL,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  void_reason  TEXT,
  created_by   INTEGER NOT NULL REFERENCES users (id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX opening_balances_one_active
  ON opening_balances (account) WHERE status = 'active';

-- Append-only change history. user_email is kept as a snapshot.
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  user_id     INTEGER NOT NULL REFERENCES users (id),
  user_email  TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('create', 'update', 'void')),
  table_name  TEXT NOT NULL,
  row_id      INTEGER,
  before_json TEXT,
  after_json  TEXT
);
CREATE INDEX audit_log_row ON audit_log (table_name, row_id);

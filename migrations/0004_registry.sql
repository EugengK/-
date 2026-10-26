-- 교적부 (membership registry).
-- People arrive from the pastor's sheet with only: 교인ID, 가정ID, 이름, 관계, 등록일.
-- Titles (직분) and attendance status are managed here, by the pastor, with full history.

ALTER TABLE members ADD COLUMN member_code TEXT;   -- 교인ID from the sheet, e.g. P-20260809-XXXXXXXX
ALTER TABLE members ADD COLUMN family_code TEXT;   -- 가정ID from the sheet
ALTER TABLE members ADD COLUMN relation TEXT;      -- 본인 / 배우자 / 자녀 ...
ALTER TABLE members ADD COLUMN registered_on TEXT; -- YYYY-MM-DD
CREATE UNIQUE INDEX members_member_code ON members (member_code) WHERE member_code IS NOT NULL;
CREATE INDEX members_family ON members (family_code);

-- Who may change the registry (titles, status, people). Separate from the finance role.
ALTER TABLE users ADD COLUMN registry_admin INTEGER NOT NULL DEFAULT 0 CHECK (registry_admin IN (0, 1));

-- Account used to attribute sheet-sync changes in the audit log. Inactive: it can never log in.
INSERT INTO users (email, name, role, is_active) VALUES ('sheet-sync@system.local', '목양 시트 자동 연동', 'viewer', 0);

CREATE TABLE titles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  term_limited INTEGER NOT NULL DEFAULT 0 CHECK (term_limited IN (0, 1)), -- 1 = appointed per year
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);
INSERT INTO titles (name, term_limited, sort_order) VALUES
  ('성도', 0, 1), ('청년', 0, 2), ('집사', 1, 3), ('장립집사', 0, 4), ('권사', 0, 5), ('장로', 0, 6);

-- A title held for a period. end_date NULL = open-ended.
CREATE TABLE member_titles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id   INTEGER NOT NULL REFERENCES members (id),
  title_id    INTEGER NOT NULL REFERENCES titles (id),
  start_date  TEXT NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(start_date) IS start_date),
  end_date    TEXT CHECK (end_date IS NULL OR (date(end_date) IS end_date AND end_date >= start_date)),
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  void_reason TEXT,
  created_by  INTEGER NOT NULL REFERENCES users (id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX member_titles_member ON member_titles (member_id, start_date);

-- Attendance history. The latest event (by date, then id) is the current status.
CREATE TABLE member_status_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id   INTEGER NOT NULL REFERENCES members (id),
  status_code TEXT NOT NULL CHECK (status_code IN ('registered', 'attending', 'inactive', 'left', 'transferred', 'returned', 'deceased')),
  event_date  TEXT NOT NULL CHECK (event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(event_date) IS event_date),
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  void_reason TEXT,
  created_by  INTEGER NOT NULL REFERENCES users (id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX member_status_member ON member_status_events (member_id, event_date);

-- People added before the registry existed and already marked inactive keep that state:
-- give them a 'left' event so the status history (which now drives is_active) agrees.
INSERT INTO member_status_events (member_id, status_code, event_date, note, created_by)
SELECT id, 'left', strftime('%Y-%m-%d', 'now'), '교적부 도입 전 비활성 처리됨', (SELECT id FROM users WHERE email = 'sheet-sync@system.local')
FROM members WHERE is_active = 0;

-- Sheet rows that look like someone already in the app (same name, not yet linked to a 교인ID).
-- Held here until the pastor says "same person" (link) or "different person" (create).
-- Only the same five sheet fields are stored.
CREATE TABLE sync_pending (
  member_code   TEXT PRIMARY KEY,
  family_code   TEXT,
  name          TEXT NOT NULL,
  relation      TEXT,
  registered_on TEXT,
  seen_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Receipt photos attached to expenses. The image itself lives in R2 (binding RECEIPTS) under r2_key.
-- Photos are never deleted: a wrong one is voided with a reason, like everything else.
CREATE TABLE expense_attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id   INTEGER NOT NULL REFERENCES expenses(id),
  r2_key       TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  void_reason  TEXT,
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_expense_attachments_expense ON expense_attachments (expense_id);

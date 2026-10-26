-- One row per saved offering form, keyed by a random id the screen generates.
-- If the same form is sent twice (retry after a dropped connection), the second send is
-- recognised and nothing is recorded twice.
CREATE TABLE offering_batches (
  client_key TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
ALTER TABLE offerings ADD COLUMN batch_key TEXT REFERENCES offering_batches (client_key);
CREATE INDEX offerings_batch ON offerings (batch_key);

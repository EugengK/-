-- A one-off expense form sends a random key; a resend after a dropped connection is then
-- recognised and not saved twice.
ALTER TABLE expenses ADD COLUMN client_key TEXT;
CREATE UNIQUE INDEX expenses_client_key ON expenses (client_key) WHERE client_key IS NOT NULL;

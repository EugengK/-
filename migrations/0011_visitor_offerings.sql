-- Offerings from visitors who are not in the 교적부 (e.g. from Launceston, Sydney, Korea).
-- Both are optional free text; a member line never has them (enforced by the API).
ALTER TABLE offerings ADD COLUMN visitor_name TEXT CHECK (visitor_name IS NULL OR length(visitor_name) BETWEEN 1 AND 50);
ALTER TABLE offerings ADD COLUMN visitor_from TEXT CHECK (visitor_from IS NULL OR length(visitor_from) BETWEEN 1 AND 50);

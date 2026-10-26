-- 교적부: birth date (age is calculated from it) and two more titles used in a Presbyterian church.
ALTER TABLE members ADD COLUMN birth_date TEXT CHECK (birth_date IS NULL OR date(birth_date) IS birth_date);
INSERT INTO titles (name, term_limited, sort_order) VALUES ('전도사', 0, 7), ('강도사', 0, 8);
ALTER TABLE sync_pending ADD COLUMN birth_date TEXT;
ALTER TABLE sync_pending ADD COLUMN title TEXT;

-- Offering types named by the pastor; more can be added in the app.
INSERT INTO fund_types (name, sort_order) VALUES
  ('주일헌금', 1),
  ('십일조', 2),
  ('선교헌금', 3),
  ('건축헌금', 4),
  ('작정헌금', 5),
  ('감사헌금', 6);

-- Church fiscal year is the calendar year; Australian reporting year is July-June.
INSERT INTO settings (key, value) VALUES
  ('church_name', '호바트한인교회'),
  ('currency', 'AUD'),
  ('church_fiscal_year_start_month', '1'),
  ('au_fiscal_year_start_month', '7');

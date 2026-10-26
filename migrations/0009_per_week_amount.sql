-- Fixed costs paid per week but once a month (e.g. a weekly stipend paid on the first Sunday):
-- amount_cents is then the weekly amount, multiplied by how many times that weekday falls in the month.
ALTER TABLE recurring_expenses ADD COLUMN amount_mode TEXT NOT NULL DEFAULT 'fixed' CHECK (amount_mode IN ('fixed', 'per_week'));

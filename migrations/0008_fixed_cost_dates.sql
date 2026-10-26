-- Fixed costs: keep the scheduled date separate from the date money actually left, so paying on a
-- different day never brings the scheduled date back; and remember from when a rule generates.
ALTER TABLE expenses ADD COLUMN scheduled_date TEXT;
UPDATE expenses SET scheduled_date = expense_date WHERE recurring_id IS NOT NULL;
DROP INDEX expenses_recurring_once;
CREATE UNIQUE INDEX expenses_recurring_once ON expenses (recurring_id, scheduled_date) WHERE recurring_id IS NOT NULL;

-- Dates before this are never generated: set when the rule is created or switched back on, so
-- payments made before the app (or while paused) don't appear as unpaid.
ALTER TABLE recurring_expenses ADD COLUMN generate_from TEXT;
UPDATE recurring_expenses SET generate_from = substr(created_at, 1, 10);

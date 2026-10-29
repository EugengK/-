-- Why a money record was changed or cancelled, shown in the change log.
ALTER TABLE audit_log ADD COLUMN reason TEXT;

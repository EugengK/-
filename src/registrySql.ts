// SQL shared by the members list, the registry and the sheet sync.

export const LEFT_CODES = ["left", "transferred", "deceased"] as const;

/** Current title / status for alias `m`, as of the date bound to the named placeholder order used by callers. */
export const CURRENT_TITLE = `(SELECT t.name FROM member_titles mt JOIN titles t ON t.id = mt.title_id
  WHERE mt.member_id = m.id AND mt.status = 'active' AND mt.start_date <= ?1
    AND (mt.end_date IS NULL OR mt.end_date >= ?1)
  ORDER BY mt.start_date DESC, mt.id DESC LIMIT 1)`;

export const CURRENT_STATUS = `(SELECT e.status_code FROM member_status_events e
  WHERE e.member_id = m.id AND e.status = 'active'
  ORDER BY e.event_date DESC, e.id DESC LIMIT 1)`;

/**
 * Keeps members.is_active in step with the latest status event: people who left, transferred
 * or died drop out of the giver list; everyone else (incl. no history yet) stays in it.
 * Bind: member id twice.
 */
export const SYNC_ACTIVE_SQL = `UPDATE members SET is_active = CASE (
    SELECT status_code FROM member_status_events WHERE member_id = ? AND status = 'active'
    ORDER BY event_date DESC, id DESC LIMIT 1)
  WHEN 'left' THEN 0 WHEN 'transferred' THEN 0 WHEN 'deceased' THEN 0 ELSE 1 END
  WHERE id = ?`;

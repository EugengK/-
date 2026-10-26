import type { AppUser } from "./types";

/** Statement recording a row change; run it in the same db.batch() as the change itself. */
export function auditStatement(
  db: D1Database,
  user: AppUser,
  action: "create" | "update" | "void",
  table: string,
  rowId: number | "last_insert",
  before: unknown,
  after: unknown,
  /** Record only if the immediately preceding statement in the batch changed a row. */
  onlyIfPreviousChanged = false,
): D1PreparedStatement {
  const rowExpr = rowId === "last_insert" ? "last_insert_rowid()" : "?";
  const binds: unknown[] = [user.id, user.email, action, table];
  if (rowId !== "last_insert") binds.push(rowId);
  binds.push(
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
  );
  const columns = "user_id, user_email, action, table_name, row_id, before_json, after_json";
  const sql = onlyIfPreviousChanged
    ? `INSERT INTO audit_log (${columns}) SELECT ?, ?, ?, ?, ${rowExpr}, ?, ? WHERE changes() > 0`
    : `INSERT INTO audit_log (${columns}) VALUES (?, ?, ?, ?, ${rowExpr}, ?, ?)`;
  return db.prepare(sql).bind(...binds);
}

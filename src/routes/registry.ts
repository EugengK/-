import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auditStatement } from "../audit";
import { todayInHobart } from "../dates";
import { CURRENT_STATUS, CURRENT_TITLE, SYNC_ACTIVE_SQL } from "../registrySql";
import type { AppEnv } from "../types";
import { isUniqueViolation, isoDate, name, optionalText, parseBody, reason } from "../validation";

const STATUS_CODES = ["registered", "attending", "inactive", "left", "transferred", "returned", "deceased"] as const;

export const registryRoutes = new Hono<AppEnv>();

// ---------- 직분 목록 ----------

interface TitleRow {
  id: number;
  name: string;
  term_limited: number;
  sort_order: number;
  is_active: number;
}
const titleOut = (t: TitleRow) => ({ ...t, term_limited: t.term_limited === 1, is_active: t.is_active === 1 });

registryRoutes.get("/titles", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, term_limited, sort_order, is_active FROM titles ORDER BY sort_order, id",
  ).all<TitleRow>();
  return c.json(results.map(titleOut));
});

const titleCreate = z
  .object({ name, term_limited: z.boolean().optional(), sort_order: z.number().int().min(0).max(9999).optional() })
  .strict();
const titleUpdate = z
  .object({
    name: name.optional(),
    term_limited: z.boolean().optional(),
    sort_order: z.number().int().min(0).max(9999).optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "바꿀 내용을 입력하세요.");

registryRoutes.post("/titles", async (c) => {
  const body = await parseBody(c, titleCreate);
  const row = { name: body.name, term_limited: body.term_limited ? 1 : 0, sort_order: body.sort_order ?? 100 };
  const db = c.env.DB;
  try {
    const [, created] = await db.batch([
      db.prepare("INSERT INTO titles (name, term_limited, sort_order) VALUES (?, ?, ?)").bind(row.name, row.term_limited, row.sort_order),
      db.prepare("SELECT id, name, term_limited, sort_order, is_active FROM titles WHERE id = last_insert_rowid()"),
      auditStatement(db, c.get("user"), "create", "titles", "last_insert", undefined, row),
    ]);
    return c.json(titleOut(created!.results[0] as TitleRow), 201);
  } catch (err) {
    if (isUniqueViolation(err)) throw new HTTPException(409, { message: "이미 있는 직분입니다." });
    throw err;
  }
});

registryRoutes.patch("/titles/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await parseBody(c, titleUpdate);
  const db = c.env.DB;
  const before = await db.prepare("SELECT id, name, term_limited, sort_order, is_active FROM titles WHERE id = ?").bind(id).first<TitleRow>();
  if (!before) throw new HTTPException(404, { message: "찾을 수 없습니다." });
  const next = {
    name: body.name ?? before.name,
    term_limited: body.term_limited === undefined ? before.term_limited : body.term_limited ? 1 : 0,
    sort_order: body.sort_order ?? before.sort_order,
    is_active: body.is_active === undefined ? before.is_active : body.is_active ? 1 : 0,
  };
  let changed: number;
  try {
    const [u] = await db.batch([
      db
        .prepare(
          `UPDATE titles SET name = ?, term_limited = ?, sort_order = ?, is_active = ?
           WHERE id = ? AND name = ? AND term_limited = ? AND sort_order = ? AND is_active = ?`,
        )
        .bind(next.name, next.term_limited, next.sort_order, next.is_active, id, before.name, before.term_limited, before.sort_order, before.is_active),
      auditStatement(db, c.get("user"), "update", "titles", id, before, { id, ...next }, true),
    ]);
    changed = u!.meta.changes;
  } catch (err) {
    if (isUniqueViolation(err)) throw new HTTPException(409, { message: "이미 있는 직분입니다." });
    throw err;
  }
  if (changed === 0) throw new HTTPException(409, { message: "다른 사람이 먼저 수정했습니다. 새로고침 후 다시 시도하세요." });
  return c.json(titleOut({ id, ...next }));
});

// ---------- 교인 상세 ----------

registryRoutes.get("/members/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const today = todayInHobart();
  const member = await db
    .prepare(
      `SELECT m.id, m.name, m.phone, m.note, m.relation, m.member_code, m.family_code, m.registered_on, m.is_active,
              ${CURRENT_TITLE} AS current_title, ${CURRENT_STATUS} AS current_status
       FROM members m WHERE m.id = ?2`,
    )
    .bind(today, id)
    .first<Record<string, unknown>>();
  if (!member) throw new HTTPException(404, { message: "찾을 수 없습니다." });

  const [titles, statuses, family, giving] = await db.batch([
    db
      .prepare(
        `SELECT mt.id, mt.title_id, t.name AS title_name, t.term_limited, mt.start_date, mt.end_date, mt.note,
                mt.status, mt.void_reason, mt.created_at
         FROM member_titles mt JOIN titles t ON t.id = mt.title_id
         WHERE mt.member_id = ? ORDER BY mt.start_date DESC, mt.id DESC`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT id, status_code, event_date, note, status, void_reason, created_at
         FROM member_status_events WHERE member_id = ? ORDER BY event_date DESC, id DESC`,
      )
      .bind(id),
    db
      .prepare("SELECT id, name, relation, is_active FROM members WHERE family_code IS NOT NULL AND family_code = ? AND id != ? ORDER BY id")
      .bind(member.family_code ?? null, id),
    db
      .prepare(
        `SELECT substr(o.offering_date, 1, 4) AS year, f.name AS fund_type_name, SUM(o.amount_cents) AS total_cents, COUNT(*) AS count
         FROM offerings o JOIN fund_types f ON f.id = o.fund_type_id
         WHERE o.member_id = ? AND o.status = 'active'
         GROUP BY year, o.fund_type_id ORDER BY year DESC, f.sort_order`,
      )
      .bind(id),
  ]);
  return c.json({
    ...member,
    is_active: member.is_active === 1,
    titles: titles!.results.map((t: any) => ({ ...t, term_limited: t.term_limited === 1 })),
    statuses: statuses!.results,
    family: family!.results.map((f: any) => ({ ...f, is_active: f.is_active === 1 })),
    giving_by_year: giving!.results,
  });
});

// ---------- 직분 이력 ----------

const assignSchema = z
  .object({ title_id: z.number().int().positive(), start_date: isoDate, end_date: isoDate.nullable().optional(), note: optionalText(300) })
  .strict();

registryRoutes.post("/members/:id{[0-9]+}/titles", async (c) => {
  const memberId = Number(c.req.param("id"));
  const body = await parseBody(c, assignSchema);
  const db = c.env.DB;
  const user = c.get("user");
  const [member, title] = await Promise.all([
    db.prepare("SELECT id FROM members WHERE id = ?").bind(memberId).first(),
    db.prepare("SELECT id, name, term_limited FROM titles WHERE id = ? AND is_active = 1").bind(body.title_id).first<TitleRow>(),
  ]);
  if (!member) throw new HTTPException(404, { message: "찾을 수 없습니다." });
  if (!title) throw new HTTPException(400, { message: "없거나 사용 중지된 직분입니다." });
  // Yearly appointments (e.g. 집사) end on 31 December of the start year unless told otherwise.
  const end = body.end_date !== undefined ? body.end_date : title.term_limited ? `${body.start_date.slice(0, 4)}-12-31` : null;
  if (end !== null && end < body.start_date) throw new HTTPException(400, { message: "종료일이 시작일보다 빠릅니다." });
  const row = { member_id: memberId, title_id: title.id, title_name: title.name, start_date: body.start_date, end_date: end, note: body.note ?? null };
  const [, created] = await db.batch([
    db
      .prepare("INSERT INTO member_titles (member_id, title_id, start_date, end_date, note, created_by) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(memberId, title.id, body.start_date, end, row.note, user.id),
    db.prepare("SELECT id, member_id, title_id, start_date, end_date, note, status FROM member_titles WHERE id = last_insert_rowid()"),
    auditStatement(db, user, "create", "member_titles", "last_insert", undefined, row),
  ]);
  return c.json(created!.results[0], 201);
});

registryRoutes.post("/member-titles/:id{[0-9]+}/void", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await parseBody(c, z.object({ reason }).strict());
  const db = c.env.DB;
  const before = await db.prepare("SELECT * FROM member_titles WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!before) throw new HTTPException(404, { message: "찾을 수 없습니다." });
  const [u] = await db.batch([
    db.prepare("UPDATE member_titles SET status = 'void', void_reason = ? WHERE id = ? AND status = 'active'").bind(body.reason, id),
    auditStatement(db, c.get("user"), "void", "member_titles", id, before, { status: "void", void_reason: body.reason }, true),
  ]);
  if (u!.meta.changes === 0) throw new HTTPException(409, { message: "이미 취소된 항목입니다." });
  return c.json({ ok: true });
});

// ---------- 출석 상태 이력 ----------

// Future dates are refused: the current status (and who appears in the giver list) is the latest
// event, so a change recorded ahead of time would take effect immediately.
const statusSchema = z
  .object({ status_code: z.enum(STATUS_CODES), event_date: isoDate, note: optionalText(300) })
  .strict()
  .refine((v) => v.event_date <= todayInHobart(), { message: "앞으로의 날짜는 기록할 수 없습니다. 그날이 되면 기록하세요.", path: ["event_date"] });

registryRoutes.post("/members/:id{[0-9]+}/status", async (c) => {
  const memberId = Number(c.req.param("id"));
  const body = await parseBody(c, statusSchema);
  const db = c.env.DB;
  const user = c.get("user");
  if (!(await db.prepare("SELECT id FROM members WHERE id = ?").bind(memberId).first())) {
    throw new HTTPException(404, { message: "찾을 수 없습니다." });
  }
  const row = { member_id: memberId, status_code: body.status_code, event_date: body.event_date, note: body.note ?? null };
  const [, created] = await db.batch([
    db
      .prepare("INSERT INTO member_status_events (member_id, status_code, event_date, note, created_by) VALUES (?, ?, ?, ?, ?)")
      .bind(memberId, body.status_code, body.event_date, row.note, user.id),
    db.prepare("SELECT id, status_code, event_date, note, status FROM member_status_events WHERE id = last_insert_rowid()"),
    auditStatement(db, user, "create", "member_status_events", "last_insert", undefined, row),
    db.prepare(SYNC_ACTIVE_SQL).bind(memberId, memberId),
  ]);
  return c.json(created!.results[0], 201);
});

registryRoutes.post("/status-events/:id{[0-9]+}/void", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await parseBody(c, z.object({ reason }).strict());
  const db = c.env.DB;
  const before = await db.prepare("SELECT * FROM member_status_events WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!before) throw new HTTPException(404, { message: "찾을 수 없습니다." });
  const memberId = before.member_id as number;
  const [u] = await db.batch([
    db.prepare("UPDATE member_status_events SET status = 'void', void_reason = ? WHERE id = ? AND status = 'active'").bind(body.reason, id),
    auditStatement(db, c.get("user"), "void", "member_status_events", id, before, { status: "void", void_reason: body.reason }, true),
    db.prepare(SYNC_ACTIVE_SQL).bind(memberId, memberId),
  ]);
  if (u!.meta.changes === 0) throw new HTTPException(409, { message: "이미 취소된 항목입니다." });
  return c.json({ ok: true });
});

// ---------- 임기 만료 예정 ----------

/** Yearly (term-limited) appointments ending in the given year, for re-appointment decisions. */
registryRoutes.get("/expiring", async (c) => {
  const year = c.req.query("year") ?? todayInHobart().slice(0, 4);
  if (!/^\d{4}$/.test(year)) throw new HTTPException(400, { message: "year: YYYY" });
  const { results } = await c.env.DB.prepare(
    `SELECT mt.id, mt.member_id, m.name AS member_name, t.name AS title_name, mt.start_date, mt.end_date, m.is_active
     FROM member_titles mt JOIN titles t ON t.id = mt.title_id JOIN members m ON m.id = mt.member_id
     WHERE mt.status = 'active' AND t.term_limited = 1 AND mt.end_date BETWEEN ? AND ?
     ORDER BY m.name, mt.id`,
  )
    .bind(`${year}-01-01`, `${year}-12-31`)
    .all<Record<string, unknown>>();
  return c.json(results.map((r) => ({ ...r, is_active: r.is_active === 1 })));
});


// ---------- 시트 연동 확인 대기 ----------

interface PendingRow {
  member_code: string;
  family_code: string | null;
  name: string;
  relation: string | null;
  registered_on: string | null;
  seen_at: string;
}

/** Sheet rows held back because someone with the same name was already entered by hand. */
registryRoutes.get("/pending", async (c) => {
  const db = c.env.DB;
  const [pending, candidates] = await db.batch([
    db.prepare("SELECT member_code, family_code, name, relation, registered_on, seen_at FROM sync_pending ORDER BY seen_at, member_code"),
    db.prepare("SELECT id, name, relation, note, registered_on FROM members WHERE member_code IS NULL ORDER BY id"),
  ]);
  const cands = candidates!.results as { id: number; name: string }[];
  return c.json(
    (pending!.results as unknown as PendingRow[]).map((p) => ({ ...p, candidates: cands.filter((m) => m.name === p.name) })),
  );
});

async function takePending(c: { env: AppEnv["Bindings"] }, code: string): Promise<PendingRow> {
  const row = await c.env.DB.prepare("SELECT * FROM sync_pending WHERE member_code = ?").bind(code).first<PendingRow>();
  if (!row) throw new HTTPException(404, { message: "확인 대기 항목이 없습니다. 새로고침하세요." });
  return row;
}

const CODE = "/pending/:code{[A-Za-z0-9-]{3,40}}";

/** "Same person": give the hand-entered member the sheet's 교인ID (keeps their giving history together). */
registryRoutes.post(`${CODE}/link`, async (c) => {
  const p = await takePending(c, c.req.param("code"));
  const body = await parseBody(c, z.object({ member_id: z.number().int().positive() }).strict());
  const db = c.env.DB;
  const before = await db
    .prepare("SELECT id, name, member_code, family_code, relation FROM members WHERE id = ?")
    .bind(body.member_id)
    .first<Record<string, unknown>>();
  if (!before) throw new HTTPException(404, { message: "찾을 수 없습니다." });
  if (before.member_code !== null) throw new HTTPException(409, { message: "이미 다른 교인ID와 연결된 분입니다." });
  const after = { member_code: p.member_code, family_code: p.family_code, relation: p.relation ?? before.relation };
  const [u] = await db.batch([
    db
      .prepare("UPDATE members SET member_code = ?, family_code = ?, relation = ? WHERE id = ? AND member_code IS NULL")
      .bind(after.member_code, after.family_code, after.relation, body.member_id),
    auditStatement(db, c.get("user"), "update", "members", body.member_id, before, after, true),
    // changes() here is the audit insert, which only happened if the link above did.
    db.prepare("DELETE FROM sync_pending WHERE member_code = ? AND changes() > 0").bind(p.member_code),
  ]);
  if (u!.meta.changes === 0) throw new HTTPException(409, { message: "이미 다른 교인ID와 연결된 분입니다." });
  return c.json({ ok: true });
});

/** "Different person": register the sheet row as a new member. */
registryRoutes.post(`${CODE}/create`, async (c) => {
  const p = await takePending(c, c.req.param("code"));
  const db = c.env.DB;
  const user = c.get("user");
  const date = p.registered_on ?? todayInHobart();
  const row = { member_code: p.member_code, name: p.name, family_code: p.family_code, relation: p.relation };
  try {
    await db.batch([
      db
        .prepare("INSERT INTO members (name, member_code, family_code, relation, registered_on) VALUES (?, ?, ?, ?, ?)")
        .bind(p.name, p.member_code, p.family_code, p.relation, date),
      auditStatement(db, user, "create", "members", "last_insert", undefined, row),
      db
        .prepare(
          "INSERT INTO member_status_events (member_id, status_code, event_date, note, created_by) SELECT id, 'registered', ?, '목양 시트에서 등록', ? FROM members WHERE member_code = ?",
        )
        .bind(date, user.id, p.member_code),
      db.prepare("DELETE FROM sync_pending WHERE member_code = ?").bind(p.member_code),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) throw new HTTPException(409, { message: "이미 등록된 교인ID입니다." });
    throw err;
  }
  return c.json({ ok: true }, 201);
});

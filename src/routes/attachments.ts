import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auditStatement } from "../audit";
import type { AppEnv } from "../types";
import { parseBody, reason } from "../validation";

/**
 * Receipt photos for expenses. The browser shrinks a photo before sending it, so a few hundred KB
 * is normal; the cap only stops mistakes. The type is decided from the file's own first bytes, not
 * from what the client claims, and an image is served back only with that type.
 */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_PHOTOS_PER_EXPENSE = 10;
export const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** The upload path is the one write that carries an image instead of JSON (see guardWrites). */
export const isPhotoUpload = (path: string) => /^\/api\/expenses\/[0-9]+\/attachments$/.test(path);

function sniff(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "image/png";
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

const COLUMNS = `a.id, a.expense_id, a.content_type, a.size_bytes, a.status, a.void_reason, a.created_at, u.name AS created_by_name`;
const FROM = "FROM expense_attachments a LEFT JOIN users u ON u.id = a.created_by";

export const attachmentRoutes = new Hono<AppEnv>();

attachmentRoutes.post("/expenses/:id{[0-9]+}/attachments", async (c) => {
  const id = Number(c.req.param("id"));
  if (Number(c.req.header("Content-Length") ?? 0) > MAX_PHOTO_BYTES) {
    throw new HTTPException(413, { message: "사진이 너무 큽니다 (10MB까지)." });
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (!bytes.length) throw new HTTPException(400, { message: "사진이 비어 있습니다." });
  if (bytes.length > MAX_PHOTO_BYTES) throw new HTTPException(413, { message: "사진이 너무 큽니다 (10MB까지)." });
  const type = sniff(bytes);
  if (!type) throw new HTTPException(415, { message: "JPEG·PNG·WEBP 사진만 올릴 수 있습니다." });

  const db = c.env.DB;
  const expense = await db
    .prepare(
      `SELECT e.status, (SELECT COUNT(*) FROM expense_attachments a WHERE a.expense_id = e.id AND a.status = 'active') AS photos
       FROM expenses e WHERE e.id = ?`,
    )
    .bind(id)
    .first<{ status: string; photos: number }>();
  if (!expense) throw new HTTPException(404, { message: "찾을 수 없습니다." });
  if (expense.status === "void") throw new HTTPException(409, { message: "취소된 지출에는 사진을 붙일 수 없습니다." });
  if (expense.photos >= MAX_PHOTOS_PER_EXPENSE) {
    throw new HTTPException(409, { message: `지출 하나에 사진은 ${MAX_PHOTOS_PER_EXPENSE}장까지입니다.` });
  }

  const key = `expenses/${id}/${crypto.randomUUID()}.${EXT[type]}`;
  await c.env.RECEIPTS.put(key, bytes, { httpMetadata: { contentType: type } });
  const row = { expense_id: id, r2_key: key, content_type: type, size_bytes: bytes.length };
  const user = c.get("user");
  try {
    const [, created] = await db.batch([
      db
        .prepare("INSERT INTO expense_attachments (expense_id, r2_key, content_type, size_bytes, created_by) VALUES (?, ?, ?, ?, ?)")
        .bind(id, key, type, bytes.length, user.id),
      // Before the audit INSERT, which moves last_insert_rowid() on.
      db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE a.id = last_insert_rowid()`),
      auditStatement(db, user, "create", "expense_attachments", "last_insert", undefined, row),
    ]);
    return c.json(created!.results[0], 201);
  } catch (err) {
    // No row points at the stored image: remove it rather than leave an orphan.
    await c.env.RECEIPTS.delete(key).catch(() => {});
    throw err;
  }
});

attachmentRoutes.get("/expenses/:id{[0-9]+}/attachments", async (c) => {
  const all = c.req.query("include_void") === "1";
  const { results } = await c.env.DB.prepare(
    `SELECT ${COLUMNS} ${FROM} WHERE a.expense_id = ? ${all ? "" : "AND a.status = 'active'"} ORDER BY a.id`,
  )
    .bind(Number(c.req.param("id")))
    .all();
  return c.json(results);
});

/** The image itself, for anyone signed in (the same people who can see the expense). */
attachmentRoutes.get("/attachments/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare("SELECT r2_key, content_type FROM expense_attachments WHERE id = ?")
    .bind(id)
    .first<{ r2_key: string; content_type: string }>();
  if (!row) throw new HTTPException(404, { message: "찾을 수 없습니다." });
  const obj = await c.env.RECEIPTS.get(row.r2_key);
  if (!obj) throw new HTTPException(404, { message: "사진 파일을 찾을 수 없습니다." });
  return new Response(obj.body, {
    headers: {
      "Content-Type": row.content_type,
      "Content-Disposition": `inline; filename="receipt-${id}.${EXT[row.content_type] ?? "img"}"`,
      // Opened on its own it is just a picture: no scripts, no forms, nothing else from this origin.
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
});

attachmentRoutes.post("/attachments/:id{[0-9]+}/void", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await parseBody(c, z.object({ reason }).strict());
  const db = c.env.DB;
  const before = await db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE a.id = ?`).bind(id).first();
  if (!before) throw new HTTPException(404, { message: "찾을 수 없습니다." });
  const [u] = await db.batch([
    db.prepare("UPDATE expense_attachments SET status = 'void', void_reason = ? WHERE id = ? AND status = 'active'").bind(b.reason, id),
    auditStatement(db, c.get("user"), "void", "expense_attachments", id, before, { status: "void", void_reason: b.reason }, true),
  ]);
  if (u!.meta.changes === 0) throw new HTTPException(409, { message: "이미 지운 사진입니다." });
  return c.json({ ok: true });
});

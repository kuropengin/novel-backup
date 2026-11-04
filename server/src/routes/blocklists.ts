import { Router } from "express";
import { isIP } from "node:net";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { nowIso } from "../db/index.js";
import { parseBody, sendError } from "../http/errors.js";
import { requireAuth } from "../auth/session.js";

/** カスタムリストの上限(ユーザーあたり) */
export const MAX_CUSTOM_BLOCKLISTS = 20;

/**
 * プリセット。サーバーはこれらの URL にアクセスしない(端末だけがダウンロードする)。
 * enabledByDefault は初回投入時のみ使い、以後のユーザーの選択は上書きしない。
 */
export const BLOCKLIST_PRESETS = [
  { key: "adguard-dns", name: "AdGuard DNS filter", url: "https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt", enabledByDefault: true },
  {
    key: "peter-lowe",
    name: "Peter Lowe's Ad and tracking server list",
    url: "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext",
    enabledByDefault: false,
  },
  { key: "oisd-small", name: "oisd small", url: "https://small.oisd.nl/domainswild", enabledByDefault: false },
  { key: "stevenblack", name: "StevenBlack hosts", url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts", enabledByDefault: false },
] as const;

/** 10 進数の正整数のみ受け付ける */
function parseId(raw: unknown): number | null {
  const s = String(raw);
  if (!/^\d{1,15}$/.test(s)) return null;
  return Number(s);
}

const httpsUrl = z
  .string()
  .trim()
  .max(2048)
  .superRefine((v, ctx) => {
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid url" });
      return;
    }
    if (u.protocol !== "https:") ctx.addIssue({ code: "custom", message: "https only" });
    if (u.username || u.password) ctx.addIssue({ code: "custom", message: "credentials not allowed" });
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (isIP(host) !== 0 || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || !host.includes(".")) {
      ctx.addIssue({ code: "custom", message: "host not allowed" });
    }
  });

const createSchema = z.object({ name: z.string().trim().min(1).max(64), url: httpsUrl }).strict();
const patchSchema = z.object({ enabled: z.boolean() }).strict();

interface Row {
  id: number;
  preset_key: string | null;
  name: string;
  url: string;
  enabled: number;
}
const toDto = (r: Row) => ({ id: r.id, presetKey: r.preset_key, name: r.name, url: r.url, enabled: r.enabled === 1 });

/** 端末ごとの広告ブロック用リスト管理。サーバーは URL を取得しない(SSRF 面を持たない)。 */
export function blocklistsRouter(db: Db): Router {
  const router = Router();
  router.use(requireAuth);

  const getRow = (id: number) =>
    db.prepare("SELECT id, preset_key, name, url, enabled FROM user_blocklists WHERE id = ?").get(id) as unknown as Row;

  /** 未投入のプリセットだけを追加する(既存行の enabled や名前は変更しない) */
  function seedPresets(userId: number): void {
    const ins = db.prepare(
      `INSERT INTO user_blocklists (user_id, preset_key, name, url, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, url) DO NOTHING`,
    );
    const has = db.prepare("SELECT 1 FROM user_blocklists WHERE user_id = ? AND preset_key = ?");
    for (const p of BLOCKLIST_PRESETS) {
      if (has.get(userId, p.key)) continue;
      ins.run(userId, p.key, p.name, p.url, p.enabledByDefault ? 1 : 0, nowIso());
    }
  }
  const list = (userId: number) =>
    (db.prepare("SELECT id, preset_key, name, url, enabled FROM user_blocklists WHERE user_id = ? ORDER BY id").all(userId) as unknown as Row[]).map(toDto);

  router.get("/", (req, res) => {
    const userId = req.user!.id;
    seedPresets(userId);
    res.json({ lists: list(userId) });
  });

  router.post("/", (req, res) => {
    const body = parseBody(createSchema, req, res);
    if (!body) return;
    const userId = req.user!.id;
    const count = (
      db.prepare("SELECT COUNT(*) AS c FROM user_blocklists WHERE user_id = ? AND preset_key IS NULL").get(userId) as unknown as { c: number }
    ).c;
    if (count >= MAX_CUSTOM_BLOCKLISTS) return sendError(res, 400, "blocklist_limit", `カスタムリストは ${MAX_CUSTOM_BLOCKLISTS} 件までです`);
    if (db.prepare("SELECT 1 FROM user_blocklists WHERE user_id = ? AND url = ?").get(userId, body.url)) {
      return sendError(res, 409, "blocklist_duplicate");
    }
    const r = db
      .prepare("INSERT INTO user_blocklists (user_id, preset_key, name, url, enabled, created_at) VALUES (?, NULL, ?, ?, 1, ?)")
      .run(userId, body.name, body.url, nowIso());
    res.status(201).json({ list: toDto(getRow(Number(r.lastInsertRowid))) });
  });

  router.patch("/:id", (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendError(res, 400, "validation_error");
    const body = parseBody(patchSchema, req, res);
    if (!body) return;
    const r = db.prepare("UPDATE user_blocklists SET enabled = ? WHERE id = ? AND user_id = ?").run(body.enabled ? 1 : 0, id, req.user!.id);
    if (r.changes === 0) return sendError(res, 404, "not_found");
    res.json({ list: toDto(getRow(id)) });
  });

  router.delete("/:id", (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendError(res, 400, "validation_error");
    const row = db.prepare("SELECT preset_key FROM user_blocklists WHERE id = ? AND user_id = ?").get(id, req.user!.id) as unknown as
      | { preset_key: string | null }
      | undefined;
    if (!row) return sendError(res, 404, "not_found");
    if (row.preset_key !== null) return sendError(res, 400, "blocklist_preset_undeletable");
    db.prepare("DELETE FROM user_blocklists WHERE id = ? AND user_id = ?").run(id, req.user!.id);
    res.json({ ok: true });
  });

  return router;
}

import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { nowIso } from "../db/index.js";
import { hashPassword } from "../auth/password.js";
import { deleteUserSessions, requireAdmin, type Role } from "../auth/session.js";
import { ah, parseBody, sendError } from "../http/errors.js";
import { passwordSchema, publicUser, usernameSchema, type UserRow } from "./auth.js";

const roleSchema = z.enum(["admin", "viewer"]);

const createSchema = z.object({ username: usernameSchema, password: passwordSchema, role: roleSchema });
const patchSchema = z.object({ role: roleSchema.optional(), password: passwordSchema.optional() });

function adminCount(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get() as unknown as { c: number }).c;
}

function findUser(db: Db, id: number): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as unknown as UserRow | undefined;
}

export function usersRouter(db: Db): Router {
  const r = Router();
  r.use(requireAdmin);

  r.get("/", (_req, res) => {
    const rows = db.prepare("SELECT * FROM users ORDER BY id").all() as unknown as UserRow[];
    res.json({ users: rows.map(publicUser) });
  });

  r.post(
    "/",
    ah(async (req, res) => {
      const body = parseBody(createSchema, req, res);
      if (!body) return;
      const hash = await hashPassword(body.password);
      try {
        const info = db
          .prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)")
          .run(body.username, hash, body.role, nowIso());
        res.status(201).json({ user: publicUser(findUser(db, Number(info.lastInsertRowid))!) });
      } catch (e) {
        if (String(e).includes("UNIQUE")) return sendError(res, 409, "username_taken");
        throw e;
      }
    }),
  );

  r.patch(
    "/:id",
    ah(async (req, res) => {
      const id = Number(req.params.id);
      const body = parseBody(patchSchema, req, res);
      if (!body) return;
      const user = Number.isInteger(id) ? findUser(db, id) : undefined;
      if (!user) return sendError(res, 404, "not_found");
      if (body.role && body.role !== user.role) {
        if (user.role === "admin" && adminCount(db) <= 1) {
          return sendError(res, 409, "last_admin", "最後の管理者のロールは変更できません");
        }
        db.prepare("UPDATE users SET role = ? WHERE id = ?").run(body.role as Role, id);
      }
      if (body.password) {
        db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(body.password), id);
        deleteUserSessions(db, id);
      }
      res.json({ user: publicUser(findUser(db, id)!) });
    }),
  );

  r.delete("/:id", (req, res) => {
    const id = Number(req.params.id);
    const user = Number.isInteger(id) ? findUser(db, id) : undefined;
    if (!user) return sendError(res, 404, "not_found");
    if (id === req.user!.id) return sendError(res, 409, "cannot_delete_self");
    if (user.role === "admin" && adminCount(db) <= 1) return sendError(res, 409, "last_admin");
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
    res.json({ ok: true });
  });

  return r;
}

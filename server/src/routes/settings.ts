import { Router } from "express";
import type { Db } from "../db/index.js";
import { requireAdmin } from "../auth/session.js";
import { parseBody } from "../http/errors.js";
import { getSettings, settingsPatchSchema, toPublicSettings, updateSettings } from "../settings.js";

export function settingsRouter(db: Db): Router {
  const r = Router();
  r.use(requireAdmin);

  r.get("/", (_req, res) => {
    res.json(toPublicSettings(getSettings(db)));
  });

  r.put("/", (req, res) => {
    const patch = parseBody(settingsPatchSchema, req, res);
    if (!patch) return;
    res.json(toPublicSettings(updateSettings(db, patch)));
  });

  return r;
}

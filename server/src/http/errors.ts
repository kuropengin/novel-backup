import type { NextFunction, Request, Response } from "express";
import type { z } from "zod";

export function sendError(res: Response, status: number, error: string, message?: string) {
  res.status(status).json(message ? { error, message } : { error });
}

/** zod で検証。失敗時は 400 を返して null。 */
export function parseBody<S extends z.ZodType>(schema: S, req: Request, res: Response): z.infer<S> | null {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) {
    res.status(400).json({ error: "validation_error", details: r.error.issues });
    return null;
  }
  return r.data;
}

/** Express 4 用 async ハンドラのラッパー。 */
export function ah(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

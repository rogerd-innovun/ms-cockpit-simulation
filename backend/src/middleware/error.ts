import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint.' } });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  // Multer rejects before the route handler runs, so without this an oversized
  // upload surfaces as a bare 500 rather than telling the user what the limit is.
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `The file is larger than the ${(env.MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)} MB upload limit.`
        : `Upload rejected: ${err.message}.`;
    res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      error: { code: err.code, message },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        // NFR-4.3 — name the field and the problem, not just a code.
        message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
        details: err.issues,
      },
    });
    return;
  }

  const message = (err as Error)?.message ?? 'Unexpected error';
  logger.error({ err }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
}

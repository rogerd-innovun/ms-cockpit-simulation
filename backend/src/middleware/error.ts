import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint.' } });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
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

  // Express's own body parsing (malformed JSON, a body over the limit) throws http-errors
  // that already carry a 4xx status and a message written for the caller.
  const httpError = err as { status?: unknown; expose?: unknown; message?: unknown };
  if (
    typeof httpError.status === 'number' &&
    httpError.status >= 400 &&
    httpError.status < 500 &&
    httpError.expose === true
  ) {
    res.status(httpError.status).json({
      error: {
        code: httpError.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
        message: String(httpError.message),
      },
    });
    return;
  }

  // The two database outcomes that are really "someone else got there first".
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({
        error: {
          code: 'CONFLICT',
          message: 'That collided with a change made at the same moment. Reload and try again.',
        },
      });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'That record no longer exists.' } });
      return;
    }
  }

  // Anything else is a bug. The cause goes to the server log, never to the client: an
  // ORM error carries file paths, query text and identifiers. The reference ties the
  // two together.
  const reference = randomUUID().slice(0, 8);
  logger.error({ err, reference, method: req.method, path: req.path }, 'unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: `Something went wrong on the server. Quote reference ${reference} when reporting it.`,
    },
  });
}

import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signToken(user: AuthUser): string {
  return jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: '12h' });
}

/** NFR-3.1 — authentication is required for all access. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    const token = header.slice('Bearer '.length);

    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload;
    } catch {
      throw unauthorized('Session expired or invalid. Sign in again.');
    }

    // Read the role from the database, not the token: a role change must take effect
    // without waiting for the token to expire.
    const user = await prisma.user.findUnique({ where: { id: String(payload.sub) } });
    if (!user) throw unauthorized('User no longer exists.');

    req.user = { id: user.id, email: user.email, name: user.name, role: user.role };
    next();
  } catch (err) {
    next(err);
  }
}

/** NFR-3.1 — roles are enforced server-side (§4). */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(
        forbidden(
          `This action requires the ${roles.join(' or ')} role; you have ${req.user.role}.`,
          'INSUFFICIENT_ROLE',
        ),
      );
    }
    next();
  };
}

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { unauthorized } from '../../lib/errors.js';
import { requireAuth, signToken } from '../../middleware/auth.js';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    // Same message either way — do not reveal which addresses exist.
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw unauthorized('Email or password is incorrect.');
    }
    const authUser = { id: user.id, email: user.email, name: user.name, role: user.role };
    res.json({ token: signToken(authUser), user: authUser });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

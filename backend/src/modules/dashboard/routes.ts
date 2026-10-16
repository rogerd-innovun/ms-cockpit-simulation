import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { DASHBOARD_PERIODS, getDashboard } from '../../services/dashboard.js';

/** The one-page overview. Read-only, and open to every signed-in role. */
export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

const query = z.object({
  // 7 / 30 / 90 days, or 0 for everything. Anything else is a typo, not a wish.
  days: z.coerce
    .number()
    .int()
    .refine((d) => (DASHBOARD_PERIODS as readonly number[]).includes(d), { message: 'days must be 7, 30, 90 or 0 (all time).' })
    .default(30),
});

dashboardRouter.get('/', async (req, res, next) => {
  try {
    const { days } = query.parse(req.query);
    res.json(await getDashboard(days));
  } catch (err) {
    next(err);
  }
});

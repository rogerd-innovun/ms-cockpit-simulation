import { POStatus } from '@prisma/client';
import { z } from 'zod';

/**
 * What the worklist endpoint accepts. Anything outside this is a 400 that names the
 * parameter — unvalidated, a bad `status` or a negative `skip` reached Prisma and came
 * back as a 500 carrying the query text.
 */
export const listQuerySchema = z.object({
  /** Comma-separated list of statuses: `?status=FAILED,EXTRACTION_FAILED`. */
  status: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.nativeEnum(POStatus)).optional()),
  q: z.string().max(200).optional(),
  mine: z.enum(['true', 'false']).optional(),
  /** Page size. Larger values are capped by the service, not refused. */
  take: z.coerce.number().int().min(1).optional(),
  skip: z.coerce.number().int().min(0).optional(),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

/** `DELETE /:id/lines/:lineNumber` */
export const lineParamsSchema = z.object({
  lineNumber: z.coerce.number().int().positive(),
});

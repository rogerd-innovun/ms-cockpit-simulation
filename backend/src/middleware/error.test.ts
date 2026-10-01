import express from 'express';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { conflict } from '../lib/errors.js';
import { errorHandler } from './error.js';

/** A throwaway app whose only route throws whatever it is told to. */
function appThrowing(make: () => unknown) {
  const app = express();
  app.use(express.json());
  app.post('/boom', () => {
    throw make();
  });
  app.use(errorHandler);
  return app;
}

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('Invalid `prisma.x()` invocation in E:\\secret\\path.ts', {
    code,
    clientVersion: 'test',
  });

describe('error responses (NFR-4.3)', () => {
  it('keeps the cause of an unexpected error out of the response', async () => {
    const res = await request(appThrowing(() => new Error('connect ECONNREFUSED E:\\secret\\path.ts SELECT * FROM "User"')))
      .post('/boom')
      .send({});
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/secret|ECONNREFUSED|SELECT/);
    expect(res.body.error.message).toMatch(/reference [0-9a-f]{8}/);
  });

  it('hides an ORM error the same way', async () => {
    const res = await request(appThrowing(() => prismaError('P2003'))).post('/boom').send({});
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/secret|invocation/);
  });

  it('gives each unexpected error its own reference', async () => {
    const app = appThrowing(() => new Error('x'));
    const a = await request(app).post('/boom').send({});
    const b = await request(app).post('/boom').send({});
    expect(a.body.error.message).not.toBe(b.body.error.message);
  });

  it('answers a unique-constraint race with 409 and a missing row with 404', async () => {
    const dup = await request(appThrowing(() => prismaError('P2002'))).post('/boom').send({});
    expect(dup.status).toBe(409);
    expect(JSON.stringify(dup.body)).not.toMatch(/secret/);
    const gone = await request(appThrowing(() => prismaError('P2025'))).post('/boom').send({});
    expect(gone.status).toBe(404);
  });

  it('answers malformed JSON with 400, not a 500', async () => {
    const res = await request(appThrowing(() => new Error('unreachable')))
      .post('/boom')
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('still passes deliberate errors through untouched', async () => {
    const res = await request(appThrowing(() => conflict('Already done.', 'CONCURRENT_UPDATE'))).post('/boom').send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONCURRENT_UPDATE', message: 'Already done.' });
  });

  it('names the field when validation fails', async () => {
    const res = await request(
      appThrowing(() => z.object({ take: z.number() }).safeParse({ take: 'x' }).error),
    )
      .post('/boom')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/^take:/);
  });
});

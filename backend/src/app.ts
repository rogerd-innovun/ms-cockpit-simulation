import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { prisma } from './db/client.js';
import { authRouter } from './modules/auth/routes.js';
import { recordsRouter } from './modules/records/routes.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { checkOutboundWritable } from './services/sap/outbound.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const BOOT_TIME = new Date().toISOString();

export function createApp() {
  const app = express();

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          // The review screen shows the PDF through an iframe whose src is a blob:
          // object URL (PdfPane). The default CSP has no frame-src, so frames fall
          // back to default-src 'self' — and 'self' never matches blob:, which
          // blanks the preview in production while "Open in new tab" still works.
          'frame-src': ["'self'", 'blob:'],
        },
      },
    }),
  );
  app.use(cors({ origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()) }));
  app.use(express.json({ limit: '2mb' }));

  /** NFR-5.1 — health checks for the pieces that fail silently. */
  app.get('/api/health', async (_req, res) => {
    const [db, outbound, inbound] = await Promise.all([
      prisma.$queryRaw`SELECT 1`.then(
        () => ({ ok: true }),
        (e: Error) => ({ ok: false, error: e.message }),
      ),
      checkOutboundWritable(),
      fs.access(env.paths.inbound).then(
        () => ({ ok: true }),
        (e: Error) => ({ ok: false, error: e.message }),
      ),
    ]);
    const ok = db.ok && outbound.ok && inbound.ok;
    res.status(ok ? 200 : 503).json({
      ok,
      checks: { database: db, outboundFolder: outbound, inboundFolder: inbound },
      config: {
        extractionProvider: env.EXTRACTION_PROVIDER,
        csvLayout: env.CSV_LAYOUT,
        completenessConvention: env.COMPLETENESS_CONVENTION,
        confidenceThreshold: env.CONFIDENCE_THRESHOLD,
        sodRequireSeparateApprover: env.SOD_REQUIRE_SEPARATE_APPROVER,
      },
      // Which build is live and when it last (re)started — on a host that sleeps
      // and redeploys on every push, "is this the new container?" is a real question.
      build: {
        startedAt: BOOT_TIME,
        gitCommit: process.env.RENDER_GIT_COMMIT ?? null,
      },
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/records', recordsRouter);

  /**
   * Single-container deployment: serve the built SPA from this process so the UI and
   * the API share an origin. Same-origin means CORS never applies to the authorised
   * PDF fetch, which is the request most likely to break behind a proxy.
   *
   * Asset filenames are content-hashed by Vite so they can be cached hard; index.html
   * must not be, or a deploy leaves clients pinned to a stale bundle.
   */
  if (env.WEB_ROOT) {
    const webRoot = env.WEB_ROOT;
    app.use(express.static(webRoot, { index: false, maxAge: '1y', immutable: true }));
    // Anything that is not an /api route is a client-side route.
    app.get(/^\/(?!api\/).*/, (_req, res, next) => {
      res.sendFile(path.join(webRoot, 'index.html'), { maxAge: 0 }, (err) => {
        if (err) next(err);
      });
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

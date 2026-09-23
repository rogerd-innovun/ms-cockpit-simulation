import { createApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './db/client.js';
import { logger } from './lib/logger.js';
import { ensureDirectories } from './services/storage.js';
import { startWorkers, stopWorkers } from './workers/index.js';

/**
 * Refuse to start misconfigured rather than failing on every extraction tick.
 *
 * Silently falling back to the mock extractor would be the worse option by far: it would
 * put invented data in front of a reviewer who has no way to tell it apart from a real
 * reading, which is exactly the failure the approval checkpoint exists to prevent.
 */
function assertExtractionConfigured() {
  if (env.EXTRACTION_PROVIDER === 'gemini' && !env.GEMINI_API_KEY) {
    throw new Error(
      'EXTRACTION_PROVIDER is "gemini" but GEMINI_API_KEY is empty.\n' +
        '  Set GEMINI_API_KEY in backend/.env to use the real extractor, or\n' +
        '  set EXTRACTION_PROVIDER=mock to run the lifecycle with a stub extractor.',
    );
  }
}

async function main() {
  assertExtractionConfigured();
  await ensureDirectories();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        provider: env.EXTRACTION_PROVIDER,
        outbound: env.paths.outbound,
        inbound: env.paths.inbound,
      },
      'cockpit API listening',
    );
  });

  if (env.WORKERS_ENABLED) startWorkers();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    stopWorkers();
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});

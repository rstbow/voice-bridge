// Express bootstrap + scheduled worker.
// Run via `npm start` which uses `node --env-file=.env` for env loading.

import express from 'express';
import cron from 'node-cron';
import { logger } from './lib/logger.js';
import { createDb } from './lib/db.js';
import { makeWebhookRouter } from './routes/webhook.js';
import { processPending } from './worker/process-pending.js';

const PORT = Number(process.env.PORT) || 3010;
const CLIENT_ID = process.env.DEFAULT_CLIENT_ID || 'junior-construction';
const WORKER_CRON = process.env.WORKER_CRON || '*/2 * * * *';
const BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE) || 20;
const MAX_RETRIES = Number(process.env.WORKER_MAX_RETRIES) || 5;

async function main() {
  const db = createDb();
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // TEMPORARY: SQL connectivity diagnostic. Returns "ok" + masked
  // server/db identification, or the error. Revert once v1 is stable.
  app.get('/diag/sql', async (_req, res) => {
    try {
      const events = await db.fetchPendingEvents(
        {
          brandUid: process.env.JUNIOR_CONSTRUCTION_BRAND_UID || 'unset',
          agentName: 'amelia',
          destinationCrm: 'acculynx',
        },
        1
      );
      res.json({
        ok: true,
        server: process.env.SQL_SERVER || 'vs-ims.database.windows.net',
        database: process.env.SQL_DATABASE || 'vs-ims-staging',
        user: process.env.SQL_USER || 'alf_bridge_app_user',
        pendingCount: events.length,
        brandUidSet: !!process.env.JUNIOR_CONSTRUCTION_BRAND_UID,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message,
        code: err.code || null,
        number: err.number || null,
        sqlPasswordSet: !!process.env.JUNIOR_CONSTRUCTION_BRIDGE_SQL_PASSWORD,
        brandUidSet: !!process.env.JUNIOR_CONSTRUCTION_BRAND_UID,
      });
    }
  });

  app.use('/webhooks', makeWebhookRouter({ db }));

  app.use((err, _req, res, _next) => {
    logger.error({ err: err.message }, 'unhandled error');
    res.status(500).json({ error: 'server_error' });
  });

  app.listen(PORT, () => {
    logger.info({ port: PORT, clientId: CLIENT_ID }, 'bridge service up');
  });

  let running = false;
  cron.schedule(WORKER_CRON, async () => {
    if (running) return; // skip overlap
    running = true;
    try {
      await processPending({
        db,
        clientId: CLIENT_ID,
        batchSize: BATCH_SIZE,
        maxRetries: MAX_RETRIES,
      });
    } catch (err) {
      logger.error({ err: err.message }, 'worker tick failed');
    } finally {
      running = false;
    }
  });
  logger.info({ cron: WORKER_CRON }, 'worker scheduled');

  const shutdown = async (sig) => {
    logger.info({ sig }, 'shutting down');
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'fatal');
  process.exit(1);
});

// End-to-end smoke test using the in-memory mock DB.
//
// Simulates: a synthetic GHL webhook payload landing -> worker picks
// it up -> calls AccuLynx (real account, creates a real test contact
// — flagged with a clear marker name).
//
// Run with: USE_MOCK_DB=1 node test/smoke.js

import { createMockDb } from '../src/lib/db.js';
import { processPending } from '../src/worker/process-pending.js';
import { logger } from '../src/lib/logger.js';

const CLIENT_ID = 'junior-construction';

const SYNTHETIC_WEBHOOK = {
  contactId: 'TEST-GHL-CONTACT-' + Date.now(),
  locationId: 'J9HRSqqxobX5ettLO65y',
  callId: 'test-call-' + Date.now(),
};

async function run() {
  // Skip the real GHL fetchContact path — needs a real GHL contact.
  // For a true smoke test, point at a real test contact ID in GHL
  // for Junior Construction. For now, this just validates the wiring.
  logger.warn(
    'smoke: synthetic test will fail at fetchContact unless contactId is real GHL contact'
  );

  const db = createMockDb();
  await db.insertCallEvent({
    clientId: CLIENT_ID,
    ghlLocationId: SYNTHETIC_WEBHOOK.locationId,
    ghlContactId: SYNTHETIC_WEBHOOK.contactId,
    ghlCallId: SYNTHETIC_WEBHOOK.callId,
    rawPayload: SYNTHETIC_WEBHOOK,
  });

  logger.info('smoke: enqueued, processing...');
  const result = await processPending({
    db,
    clientId: CLIENT_ID,
    batchSize: 5,
    maxRetries: 1,
  });
  logger.info({ result }, 'smoke: done');
}

run().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'smoke: failed');
  process.exit(1);
});

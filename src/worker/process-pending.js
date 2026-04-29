// Worker: pulls pending events from bridge.voice_agent_call_event and
// pushes to AccuLynx, then records the mapping.
//
// Idempotency strategy:
//  1. If we already have a mapping for this GHL contact id, the contact
//     is already synced — UPDATE path (PUT /contacts/{id}).
//  2. If no mapping by GHL id but a mapping by phone, we already have
//     this caller — UPDATE existing AccuLynx contact, link the new GHL
//     id to the same AccuLynx contact.
//  3. Otherwise CREATE.

import { logger } from '../lib/logger.js';
import { fetchContact, extractAmeliaFields } from '../lib/ghl.js';
import { createContact, updateContact } from '../adapters/acculynx.js';
import { getBridgeKey } from '../lib/client.js';

export async function processPending({ db, clientId, batchSize = 20, maxRetries = 5 }) {
  const key = getBridgeKey(clientId);
  const events = await db.fetchPendingEvents(key, batchSize);
  if (events.length === 0) return { processed: 0 };

  let processed = 0, failed = 0, skipped = 0;
  for (const evt of events) {
    if (evt.retry_count >= maxRetries) {
      await db.updateEventStatus(evt.event_id, 'failed', {
        lastError: `max retries (${maxRetries}) exceeded`,
      });
      failed++;
      continue;
    }
    try {
      const result = await processOneEvent({ db, clientId, key, evt });
      await db.updateEventStatus(evt.event_id, result.status, {
        destinationContactId: result.destinationContactId,
        lastError: result.note || null,
      });
      if (result.status === 'synced') processed++;
      else if (result.status === 'skipped') skipped++;
    } catch (err) {
      logger.error(
        { eventId: evt.event_id, err: err.message },
        'worker: event failed'
      );
      await db.updateEventStatus(evt.event_id, 'failed', {
        lastError: err.message,
      });
      failed++;
    }
  }
  logger.info({ processed, failed, skipped, total: events.length }, 'worker: batch done');
  return { processed, failed, skipped };
}

async function processOneEvent({ db, clientId, key, evt }) {
  const ghlContactId = evt.ghl_contact_id;
  if (!ghlContactId) {
    return { status: 'skipped', note: 'no ghl_contact_id in payload' };
  }

  // 1. Already synced this GHL contact?
  const existingBySource = await db.findMappingBySource(key, ghlContactId);

  // 2. Fetch full GHL contact + Amelia fields
  const ghlContact = await fetchContact(clientId, ghlContactId);
  if (!ghlContact) {
    return { status: 'skipped', note: 'ghl contact 404' };
  }
  const fields = extractAmeliaFields(clientId, ghlContact);

  const acculynxData = {
    firstName: fields.firstName || fields.standardFirstName || '',
    lastName: fields.lastName || fields.standardLastName || '',
    email: fields.email || fields.standardEmail || null,
    phoneE164: fields.phoneE164,
    notes: fields.callSummary || fields.reasonForCall || null,
  };

  // 1 (continued): update existing mapping
  if (existingBySource) {
    await updateContact(clientId, existingBySource.destination_contact_id, acculynxData);
    await db.upsertMapping({
      ...key,
      sourceContactId: ghlContactId,
      destinationContactId: existingBySource.destination_contact_id,
      phoneE164: acculynxData.phoneE164,
      lastEventId: evt.event_id,
    });
    return {
      status: 'synced',
      destinationContactId: existingBySource.destination_contact_id,
      note: 'updated existing (by ghl id)',
    };
  }

  // 2. Phone-based dedup via SQL mapping (AccuLynx phone-search isn't
  // supported by the public API).
  let destinationContactId = null;
  if (acculynxData.phoneE164) {
    const byPhone = await db.findMappingByPhone(key, acculynxData.phoneE164);
    if (byPhone) destinationContactId = byPhone.destination_contact_id;
  }

  if (destinationContactId) {
    await updateContact(clientId, destinationContactId, acculynxData);
    await db.upsertMapping({
      ...key,
      sourceContactId: ghlContactId,
      destinationContactId,
      phoneE164: acculynxData.phoneE164,
      lastEventId: evt.event_id,
    });
    return {
      status: 'synced',
      destinationContactId,
      note: 'updated existing (matched by phone)',
    };
  }

  // 3. Create new
  const newId = await createContact(clientId, acculynxData);
  await db.upsertMapping({
    ...key,
    sourceContactId: ghlContactId,
    destinationContactId: newId,
    phoneE164: acculynxData.phoneE164,
    lastEventId: evt.event_id,
  });
  return { status: 'synced', destinationContactId: newId, note: 'created' };
}

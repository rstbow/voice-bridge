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
import { createContact, createJob, updateContact } from '../adapters/acculynx.js';
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
    firstName: fields.firstName || '',
    lastName: fields.lastName || '',
    email: fields.email || null,
    phoneE164: fields.phoneE164,
    callbackPhone: fields.callbackPhone || null,
    address: fields.hasAddress ? fields.address : null,
    // Reason / summary cannot be stored on AccuLynx Contact/Job via
    // public API (no notes/description field). Used only for jobName
    // when creating the Job below.
    reasonForCall: fields.reasonForCall || null,
    callSummary: fields.callSummary || null,
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

  // 3. Create new contact, then a Job in 'Lead' stage tied to it.
  const newContactId = await createContact(clientId, acculynxData);

  // jobName surfaces in AccuLynx's leads list. Use a short reason summary
  // when available (server may override to contact name in some cases).
  const jobName = buildJobName(acculynxData);
  let newJobId = null;
  try {
    newJobId = await createJob(clientId, {
      contactId: newContactId,
      address: acculynxData.address,
      jobName,
    });
  } catch (err) {
    // Don't fail the whole sync if Job creation breaks — the Contact
    // already landed. Log + continue. Junior Construction can promote
    // manually from Contact in the UI as a fallback.
    logger.error(
      { err: err.message, contactId: newContactId },
      'worker: createJob failed (contact landed)'
    );
  }

  await db.upsertMapping({
    ...key,
    sourceContactId: ghlContactId,
    destinationContactId: newContactId,
    phoneE164: acculynxData.phoneE164,
    lastEventId: evt.event_id,
  });
  return {
    status: 'synced',
    destinationContactId: newContactId,
    note: newJobId ? `created contact + job ${newJobId}` : 'created contact (job failed)',
  };
}

/**
 * Build a useful jobName from the call data. AccuLynx surfaces this in
 * the Leads list. Server may silently override; we send our best.
 */
function buildJobName({ firstName, lastName, reasonForCall }) {
  const name = [firstName, lastName].filter(Boolean).join(' ').trim();
  if (reasonForCall && name) {
    return `${name} — ${reasonForCall}`.slice(0, 200);
  }
  return reasonForCall || name || 'Amelia voice intake';
}

// POST /webhooks/ghl/call-end
//
// Configured as the Outbound Webhook step on the Amelia
// callEndWorkflow ("Voice Ai End Of Call",
// id 5b89649f-6fe9-4a8f-b709-0fdd81cf6598).
//
// Auth: GHL workflow includes header X-Bridge-Token: <BRIDGE_WEBHOOK_TOKEN>.

import express from 'express';
import { logger } from '../lib/logger.js';
import { getClientConfig } from '../lib/client.js';

export function makeWebhookRouter({ db }) {
  const router = express.Router();

  router.post('/ghl/call-end', async (req, res) => {
    const token = req.get('X-Bridge-Token');
    const expected = process.env.BRIDGE_WEBHOOK_TOKEN;
    if (!expected || token !== expected) {
      logger.warn({ ip: req.ip }, 'webhook: bad token');
      return res.status(401).json({ error: 'unauthorized' });
    }

    const clientId = process.env.DEFAULT_CLIENT_ID || 'junior-construction';
    let clientCfg;
    try {
      clientCfg = getClientConfig(clientId);
    } catch (err) {
      logger.error({ err: err.message }, 'webhook: client config error');
      return res.status(500).json({ error: 'config_error', message: err.message });
    }

    const payload = req.body || {};
    const ghlContactId =
      payload.contactId || payload.contact?.id || payload.id || null;
    const ghlLocationId =
      payload.locationId || payload.location_id || clientCfg.ghlLocationId;
    const ghlCallId = payload.callId || payload.call_id || null;

    try {
      const eventId = await db.insertCallEvent({
        brandUid: clientCfg.brandUid,
        agentName: clientCfg.agentName,
        destinationCrm: clientCfg.destinationCrm,
        ghlLocationId,
        ghlContactId,
        ghlCallId,
        rawPayload: payload,
      });
      logger.info(
        { eventId, ghlContactId, clientId },
        'webhook: queued call event'
      );
      res.status(202).json({ ok: true, eventId });
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'webhook: insert failed');
      // TEMPORARY: surface error message in response while bringing v1 online.
      // Revert once stable.
      res.status(500).json({
        error: 'insert_failed',
        message: err.message,
        code: err.code || null,
        number: err.number || null,
      });
    }
  });

  return router;
}

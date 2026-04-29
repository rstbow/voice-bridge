// Client / tenant configuration.
// Wraps the multi-tenant identity used everywhere in the data layer:
//   { brandUid, agentName, destinationCrm }
//
// Single client today. When a 2nd client lands, this becomes a
// lookup against bridge.client_config (or similar).

import { logger } from './logger.js';

const CLIENT_CONFIG = {
  'junior-construction': {
    brandUid: process.env.JUNIOR_CONSTRUCTION_BRAND_UID || null,
    agentName: 'amelia',
    destinationCrm: 'acculynx',
    ghlLocationId: 'J9HRSqqxobX5ettLO65y',
  },
};

/**
 * Get the tenant key + GHL location for a clientId.
 * Throws if the clientId isn't configured or the Brand_UID env var
 * isn't set.
 */
export function getClientConfig(clientId) {
  const cfg = CLIENT_CONFIG[clientId];
  if (!cfg) throw new Error(`Unknown clientId: ${clientId}`);
  if (!cfg.brandUid) {
    throw new Error(
      `Brand_UID not configured for ${clientId}. Set ` +
      `JUNIOR_CONSTRUCTION_BRAND_UID env var. Open task: see ` +
      `team-ops/inbox-biz/2026-04-28-02-junior-construction-brand-uid.md`
    );
  }
  return cfg;
}

/**
 * Returns { brandUid, agentName, destinationCrm } — the canonical
 * key used throughout the data layer.
 */
export function getBridgeKey(clientId) {
  const c = getClientConfig(clientId);
  return {
    brandUid: c.brandUid,
    agentName: c.agentName,
    destinationCrm: c.destinationCrm,
  };
}

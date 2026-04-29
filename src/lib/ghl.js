// GoHighLevel API client.
// Scoped helpers we need for the Amelia → AccuLynx flow.
// Auth is a per-client PIT token resolved via lib/credentials.js.

import { getCredentials } from './credentials.js';

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

// Junior Construction's known GHL ids. Constants for now; multi-tenant
// later moves these into a client_config table.
const CLIENT_GHL_CONFIG = {
  'junior-construction': {
    locationId: 'J9HRSqqxobX5ettLO65y',
    agentId: '69bd6115a89980f2d8616e5e',
    // contactFieldId map — populated from Amelia's DATA_EXTRACTION
    // actions, see snapshots/ghl/2026-04-28-amelia-agent-config.json
    fields: {
      firstName:    'KwGhxpeC1yhxPBOCYvya',
      lastName:     'OJ2dZ7d6NMkCmCs12RM8',
      email:        'MFEJyqBJLI2IKedUAcUg',
      reasonForCall:'dWYNIaDlVA2N74GB7isk',
      projectDetails:'MgJdFanPweShnsf11xPK',
      projectTimeline:'onMhXjrUUNEExSVTwaiS',
      warrantyFlag: 'ZIf0RjuhFmLOK9TfElfX',
      callSummary:  'mjRJm6GkLWajVA8vYZkw',
    },
  },
};

export function ghlConfig(clientId) {
  const cfg = CLIENT_GHL_CONFIG[clientId];
  if (!cfg) throw new Error(`No GHL config for client ${clientId}`);
  return cfg;
}

function authHeaders(clientId) {
  return {
    Authorization: `Bearer ${getCredentials(clientId, 'ghl-pit')}`,
    Version: VERSION,
    'Content-Type': 'application/json',
  };
}

/**
 * Fetch a contact (with custom fields) by GHL contact id.
 * Returns the full contact object, or null if the contact doesn't exist.
 *
 * GHL quirk: 404 means not-found in some endpoints, but
 * GET /contacts/{id} returns 400 with `error: "Contact with id ... not
 * found"` when the id doesn't exist. Both treated as null here so the
 * worker classifies as 'skipped' (not 'failed') — no retry burn for
 * a missing contact.
 */
export async function fetchContact(clientId, contactId) {
  const { locationId } = ghlConfig(clientId);
  const url = `${BASE}/contacts/${contactId}?locationId=${locationId}`;
  const res = await fetch(url, { headers: authHeaders(clientId) });
  if (res.status === 404) return null;
  if (res.status === 400) {
    const body = await res.text();
    if (/not found/i.test(body)) return null;
    throw new Error(`GHL fetchContact ${contactId} -> 400: ${body}`);
  }
  if (!res.ok) {
    throw new Error(`GHL fetchContact ${contactId} -> ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  return body.contact || body;
}

/**
 * Resolve Amelia's DATA_EXTRACTION custom-field values from a contact.
 * Returns a flat object keyed by friendly name from CLIENT_GHL_CONFIG.fields.
 */
export function extractAmeliaFields(clientId, contact) {
  const { fields } = ghlConfig(clientId);
  const out = {};
  const customFields = contact?.customFields || contact?.customField || [];
  const byId = {};
  for (const f of customFields) byId[f.id] = f.value ?? f.fieldValue;
  for (const [friendly, fieldId] of Object.entries(fields)) {
    out[friendly] = byId[fieldId] ?? null;
  }
  // Standard contact fields (in case Amelia didn't fill them via custom fields).
  out.standardFirstName = contact?.firstName ?? out.firstName;
  out.standardLastName  = contact?.lastName  ?? out.lastName;
  out.standardEmail     = contact?.email     ?? out.email;
  out.phoneE164         = contact?.phone     ?? null;
  return out;
}

/**
 * Fetch a single voice-ai call log by id (for transcript/recording links).
 * Optional — if we want to enrich the AccuLynx note with the call transcript.
 */
export async function fetchCallLog(clientId, callId) {
  const { locationId } = ghlConfig(clientId);
  // Endpoint pattern: /voice-ai/dashboard/call-logs?locationId=...&page=N
  // Single-call lookup TBD; for now just return null and skip enrichment.
  return null;
}

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
    // Custom-field IDs Amelia populates via DATA_EXTRACTION actions.
    // Standard GHL contact fields (firstName, lastName, email, phone,
    // address1, city, state, postalCode) are read directly off the
    // contact response — not via contactFieldId lookup. The IN_CALL_*
    // extractions target those standard fields under the hood.
    customFields: {
      reasonForCall:   'dWYNIaDlVA2N74GB7isk',
      projectDetails:  'MgJdFanPweShnsf11xPK',
      projectTimeline: 'onMhXjrUUNEExSVTwaiS',
      warrantyFlag:    'ZIf0RjuhFmLOK9TfElfX',
      callSummary:     'mjRJm6GkLWajVA8vYZkw',
      callbackPhone:   '1snk4vUsrHhOhe7DewYR', // added 2026-04-29 by Alf
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
 * Resolve Amelia's DATA_EXTRACTION values from a GHL contact.
 *
 * Returns a flat object with both the structured custom-field values
 * (Amelia's DATA_EXTRACTION actions) and the standard contact fields
 * (firstName, lastName, email, phone, address1/city/state/postalCode)
 * which GHL populates either natively (caller ID for phone) or via
 * IN_CALL_DATA_EXTRACTION actions targeting standard field IDs.
 */
export function extractAmeliaFields(clientId, contact) {
  const { customFields: cfMap } = ghlConfig(clientId);
  const out = {};

  // Custom fields (DATA_EXTRACTION outputs).
  const cfList = contact?.customFields || contact?.customField || [];
  const byId = {};
  for (const f of cfList) byId[f.id] = f.value ?? f.fieldValue;
  for (const [friendly, fieldId] of Object.entries(cfMap)) {
    out[friendly] = byId[fieldId] ?? null;
  }

  // Standard contact fields. These are top-level on the contact object.
  out.firstName  = contact?.firstName  ?? null;
  out.lastName   = contact?.lastName   ?? null;
  out.email      = contact?.email      ?? null;
  // Phone resolution: caller ID native (best) → callback-phone extraction (fallback).
  out.phoneE164  = contact?.phone || out.callbackPhone || null;

  // Address (standard GHL contact fields, populated by Amelia's
  // IN_CALL_DATA_EXTRACTION Street Address / Your City / Your State / ZipCode).
  out.address    = {
    street1:    contact?.address1   ?? null,
    street2:    contact?.address2   ?? null,
    city:       contact?.city       ?? null,
    state:      contact?.state      ?? null, // typically a 2-letter abbr OR full name
    postalCode: contact?.postalCode ?? null,
    country:    contact?.country    ?? null, // typically 'US' or 'United States'
  };
  out.hasAddress = !!(out.address.street1 || out.address.city || out.address.postalCode);

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

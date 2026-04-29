// AccuLynx v2 adapter — single adapter today (Junior Construction).
// Future clients with different CRMs add sibling files implementing
// the same interface (search, create, update).

import { getCredentials } from '../lib/credentials.js';
import { ACCULYNX_US_STATES } from '../lib/states.js';

const BASE = 'https://api.acculynx.com/api/v2';

// AccuLynx contact-type GUIDs — pulled 2026-04-28 from Junior Construction's
// AccuLynx admin via DevTools network tab. Snapshot at
// team-ops/projects/junior-construction/snapshots/acculynx/2026-04-28-contact-types.json
//
// Decision (Randy 2026-04-28): new Amelia leads land as 'General Contact'.
const CLIENT_ACCULYNX_CONFIG = {
  'junior-construction': {
    contactTypeIdGeneralContact: '64fac10a-95c0-46b0-b521-3422bbf77154',
    contactTypeIdCustomer:        '52ba94c5-3ecf-4e7f-90cd-a91de12a72f5',
    defaultContactTypeForLead:    '64fac10a-95c0-46b0-b521-3422bbf77154',
  },
};

export function acculynxConfig(clientId) {
  const cfg = CLIENT_ACCULYNX_CONFIG[clientId];
  if (!cfg) throw new Error(`No AccuLynx config for client ${clientId}`);
  return cfg;
}

function authHeaders(clientId) {
  return {
    Authorization: `Bearer ${getCredentials(clientId, 'acculynx-bearer')}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Search AccuLynx contacts within a date range, with optional pagination.
 * Body shape verified 2026-04-28:
 *   { sort: { field, direction }, pageSize, startDate, endDate, pageStartIndex }
 * dates must be YYYY-MM-DD (not ISO-datetime).
 *
 * IMPORTANT (2026-04-28): we tested phone, phoneNumber, primaryPhone,
 * phoneNumbers, phoneNumberSearch as filter fields — **none filter**.
 * /contacts/search returns the full set regardless of phone params.
 * **The public API does not expose contact-search-by-phone.**
 *
 * Phone-dedup strategy v1:
 *   - Trust the SQL mapping table as the source of truth.
 *   - For contacts created via the bridge, we always have the mapping.
 *   - Limitation: contacts created in AccuLynx UI directly (manual
 *     entry) won't be matched. Surface as a v1.5 reconcile job that
 *     paginates /contacts/search by date range and refreshes a phone
 *     index in SQL.
 */
export async function searchContacts(clientId, { startDate, endDate, pageSize = 50, pageStartIndex = 0 } = {}) {
  const url = `${BASE}/contacts/search`;
  const body = {
    sort: { field: 'LastName', direction: 'Ascending' },
    pageSize,
    pageStartIndex,
    startDate: startDate || '2000-01-01',
    endDate: endDate || new Date().toISOString().slice(0, 10),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(clientId),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`AccuLynx searchContacts ${res.status}: ${txt}`);
  }
  return await res.json();
}

/**
 * Find a contact by phone — NOT supported via the public search API
 * (verified 2026-04-28; no documented phone filter actually filters).
 *
 * Always returns null in v1; the caller falls back to the SQL mapping
 * table for dedup. v1.5 will populate a server-side phone index from
 * a paginated full-table refresh.
 */
export async function findContactByPhone(clientId, phoneE164) {
  return null;
}

/**
 * Build a structured AccuLynx mailingAddress from a GHL address object.
 * GHL state can come as 2-letter abbr ("MO") or full name ("Missouri").
 * Returns null if no usable street/city/zip is present.
 */
function buildMailingAddress(address) {
  if (!address) return null;
  const { street1, street2, city, state, postalCode, country } = address;
  if (!street1 && !city && !postalCode) return null;

  // Resolve state -> AccuLynx state.id by 2-letter abbr.
  let stateRef = null;
  if (state) {
    const abbr = state.length === 2 ? state.toUpperCase()
      : Object.entries(ACCULYNX_US_STATES).find(
          ([, v]) => v.name.toLowerCase() === state.toLowerCase()
        )?.[0];
    if (abbr && ACCULYNX_US_STATES[abbr]) {
      stateRef = { id: ACCULYNX_US_STATES[abbr].id };
    }
  }

  const out = {
    street1: street1 || '',
    street2: street2 || '',
    city: city || '',
    zipCode: postalCode || '',
    country: { id: 1 }, // default US — country mapping can come later
  };
  if (stateRef) out.state = stateRef;
  return out;
}

/**
 * Create a new AccuLynx contact.
 * Returns the created contact's id.
 */
export async function createContact(clientId, contactData) {
  const cfg = acculynxConfig(clientId);
  const url = `${BASE}/contacts`;
  const mailingAddress = buildMailingAddress(contactData.address);
  const body = {
    contactTypeIds: [
      contactData.contactTypeId || cfg.defaultContactTypeForLead,
    ],
    firstName: contactData.firstName || '',
    lastName: contactData.lastName || '',
    companyName: contactData.companyName || '',
    emailAddresses: contactData.email
      ? [{ address: contactData.email, type: 'Personal', primary: true }]
      : [],
    phoneNumbers: contactData.phoneE164
      ? [{ number: contactData.phoneE164, type: 'Mobile', primary: true }]
      : [],
    ...(mailingAddress && { mailingAddress }),
    // TODO(2026-04-29): confirm field name — `description` vs sub-resource.
    ...(contactData.notes ? { description: contactData.notes } : {}),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(clientId),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`AccuLynx createContact ${res.status}: ${txt}`);
  }
  const json = await res.json();
  return json.id || json.contactId || json;
}

/**
 * Update an existing AccuLynx contact (PUT /contacts/{id}).
 * OPTIONS reports Allow: GET, PUT for /contacts/{id}.
 *
 * NOT YET VERIFIED end-to-end — first call against a real contact
 * should be against a benign no-op payload to confirm semantics.
 * TODO(2026-04-29): verify before wiring into the worker happy path.
 */
export async function updateContact(clientId, acculynxContactId, contactData) {
  const url = `${BASE}/contacts/${acculynxContactId}`;
  const body = {
    // PUT semantics in AccuLynx are likely full-replace — fetch + merge
    // before send. TODO: confirm and implement merge logic.
    firstName: contactData.firstName,
    lastName: contactData.lastName,
    ...(contactData.email && {
      emailAddresses: [
        { address: contactData.email, type: 'Personal', primary: true },
      ],
    }),
    ...(contactData.notes && { description: contactData.notes }),
  };
  const res = await fetch(url, {
    method: 'PUT',
    headers: authHeaders(clientId),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`AccuLynx updateContact ${res.status}: ${txt}`);
  }
  return await res.json();
}

/**
 * Validate the bearer is alive. Cheap probe.
 */
export async function ping(clientId) {
  const res = await fetch(`${BASE}/acculynx/countries`, {
    headers: authHeaders(clientId),
  });
  return res.ok;
}

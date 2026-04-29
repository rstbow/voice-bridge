// Credential resolver.
//
// Wired as getCredentials(clientId, name) from day one even though it
// currently just resolves files in team-ops/secrets/. When we go
// multi-tenant, this is the one place that becomes a per-client
// lookup (Key Vault refs, per-client secret folders, etc.) — call
// sites don't change.

import fs from 'node:fs';
import path from 'node:path';

const SECRETS_ROOT = process.env.SECRETS_ROOT
  || 'C:/c-code001/team-ops/secrets';

const KNOWN = {
  'junior-construction': {
    'ghl-pit': 'junior-construction-ghl-pit.md',
    'acculynx-bearer': 'junior-construction-acculynx-bearer.md',
    'bridge-sql-password': 'junior-construction-bridge-sql.md',
  },
  // shared across all clients (the bridge SQL login is multi-tenant)
  // — until clients diverge, every client uses the same SQL login.
  // future: 'meal-club': { 'ghl-pit': 'meal-club-ghl-pit.md' }, ...
};

/**
 * Extract the ## Value block from a secret markdown file.
 * Convention: a single backtick-delimited line directly under "## Value".
 */
function parseSecretFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const m = text.match(/^##\s+Value\s*\n+`([^`\n]+)`\s*$/m);
  if (!m) {
    throw new Error(`Could not parse value from ${filePath}`);
  }
  return m[1].trim();
}

/**
 * @param {string} clientId  e.g. 'junior-construction'
 * @param {string} name      e.g. 'ghl-pit', 'acculynx-bearer'
 * @returns {string}         the secret value
 */
export function getCredentials(clientId, name) {
  const clientMap = KNOWN[clientId];
  if (!clientMap) throw new Error(`Unknown clientId: ${clientId}`);
  const file = clientMap[name];
  if (!file) {
    throw new Error(`Unknown secret '${name}' for client '${clientId}'`);
  }
  return parseSecretFile(path.join(SECRETS_ROOT, file));
}

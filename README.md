# junior-construction-ghl

Bridge service: Amelia (GHL voice agent at Junior Construction) →
AccuLynx contact sync.

Single-tenant today (`junior-construction`); data shape is multi-tenant
ready (`client_id` column, `clientId` parameter threaded through call
sites, adapter pattern) so a future client with a different destination
CRM is config + a new adapter, not a rewrite.

## Status

Skeleton scaffolded 2026-04-28 (Alf, ai-builder chat). **Not yet
runnable end-to-end** — gated on the `bridge.*` schema being created
in Azure SQL, which is filed with Chip:
`team-ops/projects/junior-construction/inbox-sql/2026-04-28-01-bridge-schema-amelia-acculynx.md`

## Architecture

See `docs/architecture.md`. Short version:

```
Amelia call ends
  → GHL upserts contact (with custom-field extractions)
  → callEndWorkflow fires
  → workflow has Outbound Webhook → POST /webhooks/ghl/call-end
  → service writes raw payload to bridge.amelia_call_event (status='pending')
  → respond 202 immediately
  
Worker (every 2 min via node-cron):
  → SELECT pending events
  → for each: fetch full GHL contact, search AccuLynx by phone,
    create or PUT-update contact, record mapping
  → mark event 'synced' or 'failed' with error details
```

## Layout

```
src/
  index.js                 Express bootstrap + worker scheduler
  lib/
    credentials.js         getCredentials(clientId, name) — file-backed today
    ghl.js                 GHL API client (PIT auth, contact + custom field helpers)
    db.js                  SQL interface (mockable for tests)
    logger.js              pino logger
  adapters/
    acculynx.js            search/create/update contacts via AccuLynx v2 API
  routes/
    webhook.js             POST /webhooks/ghl/call-end
  worker/
    process-pending.js     pulls pending events, calls adapter, updates state
test/
  smoke.js                 end-to-end synthetic payload (mockable DB)
  acculynx-probe.js        verify AccuLynx writes against real account
docs/
  architecture.md
```

## Running locally

```sh
npm install
cp .env.example .env
# fill in .env with values from team-ops/secrets/
npm run dev      # starts Express + worker
npm run test:smoke
```

## Secrets

Pulled from `C:\c-code001\team-ops\secrets\` via
`lib/credentials.js`. Never committed.

- `junior-construction-ghl-pit.md` — GHL PIT (read/write voice-ai +
  contacts)
- `junior-construction-acculynx-bearer.md` — AccuLynx v2 bearer

## Open items

- [ ] **Chip's DDL** lands → run via `sql-to-run/`, then wire up
  `lib/db.js`.
- [ ] **Verify AccuLynx PUT** for contact updates with a real benign
  payload (OPTIONS reports PUT is allowed; not yet confirmed end-to-end).
- [ ] **Identify GHL workflow `5b89649f-6fe9-4a8f-b709-0fdd81cf6598`**
  — what does it do today? Add Outbound Webhook step.
- [ ] **Deploy target** — Azure App Service B1 in a new resource group
  (separate from skc-admin's). Will configure when v1 is functional
  locally.

# junior-construction-ghl — architecture

## Flow

```
[Amelia call ends]
   │ GHL upserts contact (custom fields populated by Amelia's
   │ DATA_EXTRACTION actions: First Name, Last Name, Email, Reason,
   │ Project Details, Project Timeline, Warranty Flag, Call Summary)
   │
   ▼
[GHL Workflow 5b89649f-6fe9-4a8f-b709-0fdd81cf6598 (callEndWorkflow)]
   │ Outbound Webhook step (added by us during build):
   │   POST  https://<service>/webhooks/ghl/call-end
   │   Headers: X-Bridge-Token: <BRIDGE_WEBHOOK_TOKEN>
   │   Body:    GHL contact + call payload (JSON)
   │
   ▼
[bridge service — Express]
   │ /webhooks/ghl/call-end:
   │   1. validate token
   │   2. INSERT raw payload into bridge.amelia_call_event (status='pending')
   │   3. respond 202
   │
   ▼
[bridge.amelia_call_event] ←—— Azure SQL (vs-ims server)
   │
   ▼
[worker — node-cron every 2 min]
   │ for each pending event:
   │   1. SELECT pending events WITH (READPAST, ROWLOCK, UPDLOCK)
   │   2. fetch full GHL contact via PIT (resolve custom-field values)
   │   3. lookup mapping by ghl_contact_id  → already synced? UPDATE path
   │   4. else lookup mapping by phone       → matched? UPDATE remote
   │   5. else search AccuLynx by phone      → match in their DB? UPDATE
   │   6. else CREATE new AccuLynx contact (type=General Contact)
   │   7. upsert bridge.amelia_acculynx_contact_map
   │   8. mark event 'synced' (or 'failed' with error)
   │
   ▼
[AccuLynx — contact created or updated]
```

## Data shape

Two tables, schema `bridge.*` (multi-tenant ready, single client today).
DDL designed by Chip; see
`team-ops/projects/junior-construction/inbox-sql/2026-04-28-01-bridge-schema-amelia-acculynx.md`.

- `bridge.amelia_call_event` — staging
- `bridge.amelia_acculynx_contact_map` — idempotency / dedup mapping

Both tables include `client_id` defaulting to `'junior-construction'`.

## Multi-tenant readiness checklist

- [x] All tables include `client_id` column
- [x] Indexes are `(client_id, ...)`-leading
- [x] Service threads `clientId` parameter through every call site
- [x] `getCredentials(clientId, name)` is the only place secrets are
      resolved
- [x] AccuLynx logic isolated in `src/adapters/acculynx.js`
- [x] GHL config keyed by client in `src/lib/ghl.js`'s `CLIENT_GHL_CONFIG`
- [ ] (deferred) `client_config` table when a 2nd client lands
- [ ] (deferred) `field_mapping` table when client field mappings diverge
- [ ] (deferred) Onboarding UI / dashboard

## Outstanding TODOs

1. Verify AccuLynx `PUT /contacts/{id}` semantics (Allow header reports
   PUT supported; not yet exercised).
2. Confirm AccuLynx contact-notes field name (`description` vs.
   `notes` vs. sub-resource `/contacts/{id}/notes`).
3. Nail `POST /contacts/search` body shape — phone-filter field name
   + valid `startDate`.
4. Identify GHL workflow `5b89649f-...` purpose; add Outbound Webhook
   step alongside whatever's there.
5. Wire env from production secrets when Azure App Service is
   provisioned.

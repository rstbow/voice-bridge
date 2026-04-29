// SQL data access — bridge.voice_agent_call_event +
// bridge.voice_agent_crm_contact_map.
//
// Schema designed by Chip (sql-specialist), filed at
// team-ops/projects/junior-construction/sql-to-run/2026-04-28-01-bridge-schema-create.md
//
// Multi-tenant from day one via 3 columns on every row:
//   - Brand_UID         UNIQUEIDENTIFIER  (joins tbl_PPA_L_Brand)
//   - agent_name        VARCHAR(64)        ('amelia' today)
//   - destination_crm   VARCHAR(64)        ('acculynx' today)
//
// Two flavors:
//  - createSqlDb()  — real Azure SQL via mssql, used in prod
//  - createMockDb() — in-memory store, used in tests + smoke runs

import sql from 'mssql';
import { logger } from './logger.js';
import { getCredentials } from './credentials.js';

/**
 * @typedef {Object} BridgeKey
 * @property {string} brandUid       UNIQUEIDENTIFIER as string
 * @property {string} agentName      e.g. 'amelia'
 * @property {string} destinationCrm e.g. 'acculynx'
 */

/**
 * @typedef {Object} BridgeDb
 * @property {(evt: object) => Promise<string>} insertCallEvent  returns event_id
 * @property {(key: BridgeKey, limit: number) => Promise<object[]>} fetchPendingEvents
 * @property {(eventId: string, status: string, fields?: object) => Promise<void>} updateEventStatus
 * @property {(key: BridgeKey, sourceContactId: string) => Promise<object|null>} findMappingBySource
 * @property {(key: BridgeKey, phoneE164: string) => Promise<object|null>} findMappingByPhone
 * @property {(mapping: object) => Promise<void>} upsertMapping
 * @property {() => Promise<void>} close
 */

// ============================================================
// Real SQL implementation
// ============================================================

let pool = null;

async function getPool() {
  if (pool) return pool;
  // Password resolves from team-ops/secrets/ via getCredentials so it
  // lives in ONE place. In production, override the secrets-dir with
  // SECRETS_ROOT pointing at a Key Vault mount or similar.
  const clientId = process.env.DEFAULT_CLIENT_ID || 'junior-construction';
  const password =
    process.env.SQL_PASSWORD || // explicit override (Azure App Service env var)
    getCredentials(clientId, 'bridge-sql-password');
  pool = await sql.connect({
    server: process.env.SQL_SERVER || 'vs-ims.database.windows.net',
    database: process.env.SQL_DATABASE || 'vs-ims-staging',
    user: process.env.SQL_USER || 'alf_bridge_app_user',
    password,
    options: { encrypt: true, trustServerCertificate: false },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  });
  return pool;
}

/** @returns {BridgeDb} */
export function createSqlDb() {
  return {
    async insertCallEvent(evt) {
      const p = await getPool();
      const r = await p.request()
        .input('brand_uid', sql.UniqueIdentifier, evt.brandUid)
        .input('agent_name', sql.VarChar(64), evt.agentName)
        .input('destination_crm', sql.VarChar(64), evt.destinationCrm)
        .input('ghl_location_id', sql.VarChar(64), evt.ghlLocationId)
        .input('ghl_contact_id', sql.VarChar(64), evt.ghlContactId || null)
        .input('ghl_call_id', sql.VarChar(128), evt.ghlCallId || null)
        .input('raw_payload', sql.NVarChar(sql.MAX), JSON.stringify(evt.rawPayload))
        .query(`
          INSERT INTO bridge.voice_agent_call_event
            (Brand_UID, agent_name, destination_crm, ghl_location_id,
             ghl_contact_id, ghl_call_id, raw_payload)
          OUTPUT INSERTED.event_id
          VALUES (@brand_uid, @agent_name, @destination_crm, @ghl_location_id,
                  @ghl_contact_id, @ghl_call_id, @raw_payload);
        `);
      return r.recordset[0].event_id;
    },

    async fetchPendingEvents({ agentName, destinationCrm }, limit) {
      const p = await getPool();
      const r = await p.request()
        .input('agent_name', sql.VarChar(64), agentName)
        .input('destination_crm', sql.VarChar(64), destinationCrm)
        .input('limit', sql.Int, limit)
        .query(`
          SELECT TOP (@limit) *
          FROM bridge.voice_agent_call_event WITH (READPAST, ROWLOCK, UPDLOCK)
          WHERE agent_name = @agent_name
            AND destination_crm = @destination_crm
            AND status = 'pending'
          ORDER BY received_utc;
        `);
      return r.recordset;
    },

    async updateEventStatus(eventId, status, fields = {}) {
      const p = await getPool();
      await p.request()
        .input('event_id', sql.UniqueIdentifier, eventId)
        .input('status', sql.VarChar(16), status)
        .input('last_error', sql.NVarChar(sql.MAX), fields.lastError || null)
        .input('destination_contact_id', sql.NVarChar(64), fields.destinationContactId || null)
        .query(`
          UPDATE bridge.voice_agent_call_event
          SET status = @status,
              processed_utc = SYSUTCDATETIME(),
              last_error = COALESCE(@last_error, last_error),
              destination_contact_id = COALESCE(@destination_contact_id, destination_contact_id),
              retry_count = CASE WHEN @status = 'failed' THEN retry_count + 1 ELSE retry_count END
          WHERE event_id = @event_id;
        `);
    },

    async findMappingBySource({ brandUid, agentName, destinationCrm }, sourceContactId) {
      const p = await getPool();
      const r = await p.request()
        .input('brand_uid', sql.UniqueIdentifier, brandUid)
        .input('agent_name', sql.VarChar(64), agentName)
        .input('destination_crm', sql.VarChar(64), destinationCrm)
        .input('source_contact_id', sql.VarChar(64), sourceContactId)
        .query(`
          SELECT * FROM bridge.voice_agent_crm_contact_map
          WHERE Brand_UID = @brand_uid
            AND agent_name = @agent_name
            AND destination_crm = @destination_crm
            AND source_contact_id = @source_contact_id;
        `);
      return r.recordset[0] || null;
    },

    async findMappingByPhone({ brandUid, agentName, destinationCrm }, phoneE164) {
      if (!phoneE164) return null;
      const p = await getPool();
      const r = await p.request()
        .input('brand_uid', sql.UniqueIdentifier, brandUid)
        .input('agent_name', sql.VarChar(64), agentName)
        .input('destination_crm', sql.VarChar(64), destinationCrm)
        .input('phone_e164', sql.VarChar(20), phoneE164)
        .query(`
          SELECT TOP 1 * FROM bridge.voice_agent_crm_contact_map
          WHERE Brand_UID = @brand_uid
            AND agent_name = @agent_name
            AND destination_crm = @destination_crm
            AND phone_e164 = @phone_e164
          ORDER BY last_synced_utc DESC;
        `);
      return r.recordset[0] || null;
    },

    async upsertMapping(m) {
      const p = await getPool();
      // Per Chip's note: "INSERT ... WHERE NOT EXISTS + separate UPDATE
      // is safer than MERGE on small tables." Following that guidance.
      const req = p.request()
        .input('brand_uid', sql.UniqueIdentifier, m.brandUid)
        .input('agent_name', sql.VarChar(64), m.agentName)
        .input('destination_crm', sql.VarChar(64), m.destinationCrm)
        .input('source_contact_id', sql.VarChar(64), m.sourceContactId)
        .input('destination_contact_id', sql.NVarChar(64), m.destinationContactId)
        .input('phone_e164', sql.VarChar(20), m.phoneE164 || null)
        .input('last_event_id', sql.UniqueIdentifier, m.lastEventId || null);

      // UPDATE first; INSERT only if no row affected.
      const upd = await req.query(`
        UPDATE bridge.voice_agent_crm_contact_map
        SET destination_contact_id = @destination_contact_id,
            phone_e164 = COALESCE(@phone_e164, phone_e164),
            last_synced_utc = SYSUTCDATETIME(),
            last_event_id = @last_event_id
        WHERE Brand_UID = @brand_uid
          AND agent_name = @agent_name
          AND destination_crm = @destination_crm
          AND source_contact_id = @source_contact_id;
        SELECT @@ROWCOUNT AS rc;
      `);
      if (upd.recordset[0].rc > 0) return;

      await req.query(`
        INSERT INTO bridge.voice_agent_crm_contact_map
          (Brand_UID, agent_name, destination_crm, source_contact_id,
           destination_contact_id, phone_e164, last_event_id)
        VALUES (@brand_uid, @agent_name, @destination_crm, @source_contact_id,
                @destination_contact_id, @phone_e164, @last_event_id);
      `);
    },

    async close() {
      if (pool) {
        await pool.close();
        pool = null;
      }
    },
  };
}

// ============================================================
// In-memory mock for tests / smoke runs before Chip's DDL is in
// ============================================================

/** @returns {BridgeDb} */
export function createMockDb() {
  const events = new Map();      // event_id -> row
  const mappings = new Map();    // composite key string -> row
  let seq = 0;
  const newId = () =>
    `00000000-0000-0000-0000-${String(++seq).padStart(12, '0')}`;
  const mapKey = (brandUid, agentName, destinationCrm, sourceContactId) =>
    `${brandUid}|${agentName}|${destinationCrm}|${sourceContactId}`;

  return {
    async insertCallEvent(evt) {
      const event_id = newId();
      events.set(event_id, {
        event_id,
        Brand_UID: evt.brandUid,
        agent_name: evt.agentName,
        destination_crm: evt.destinationCrm,
        ghl_location_id: evt.ghlLocationId,
        ghl_contact_id: evt.ghlContactId || null,
        ghl_call_id: evt.ghlCallId || null,
        raw_payload: JSON.stringify(evt.rawPayload),
        status: 'pending',
        retry_count: 0,
        last_error: null,
        received_utc: new Date().toISOString(),
        processed_utc: null,
        destination_contact_id: null,
      });
      return event_id;
    },
    async fetchPendingEvents({ agentName, destinationCrm }, limit) {
      return [...events.values()]
        .filter(e =>
          e.agent_name === agentName &&
          e.destination_crm === destinationCrm &&
          e.status === 'pending'
        )
        .sort((a, b) => a.received_utc.localeCompare(b.received_utc))
        .slice(0, limit);
    },
    async updateEventStatus(eventId, status, fields = {}) {
      const e = events.get(eventId);
      if (!e) return;
      e.status = status;
      e.processed_utc = new Date().toISOString();
      if (fields.lastError) e.last_error = fields.lastError;
      if (fields.destinationContactId) e.destination_contact_id = fields.destinationContactId;
      if (status === 'failed') e.retry_count++;
    },
    async findMappingBySource({ brandUid, agentName, destinationCrm }, sourceContactId) {
      return mappings.get(mapKey(brandUid, agentName, destinationCrm, sourceContactId)) || null;
    },
    async findMappingByPhone({ brandUid, agentName, destinationCrm }, phoneE164) {
      if (!phoneE164) return null;
      for (const m of mappings.values()) {
        if (
          m.Brand_UID === brandUid &&
          m.agent_name === agentName &&
          m.destination_crm === destinationCrm &&
          m.phone_e164 === phoneE164
        ) return m;
      }
      return null;
    },
    async upsertMapping(m) {
      mappings.set(mapKey(m.brandUid, m.agentName, m.destinationCrm, m.sourceContactId), {
        Brand_UID: m.brandUid,
        agent_name: m.agentName,
        destination_crm: m.destinationCrm,
        source_contact_id: m.sourceContactId,
        destination_contact_id: m.destinationContactId,
        phone_e164: m.phoneE164 || null,
        last_event_id: m.lastEventId || null,
        first_synced_utc: new Date().toISOString(),
        last_synced_utc: new Date().toISOString(),
      });
    },
    async close() { /* noop */ },
  };
}

export function createDb() {
  if (process.env.USE_MOCK_DB === '1') {
    logger.warn('Using in-memory mock DB (USE_MOCK_DB=1)');
    return createMockDb();
  }
  return createSqlDb();
}

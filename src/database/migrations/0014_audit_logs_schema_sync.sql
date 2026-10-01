-- #289: idx_audit_logs_event and idx_audit_logs_created_at were already
-- created by migration 0006_create_audit_logs.sql, but schema.ts's
-- auditLogs table definition never declared them, so the Drizzle schema
-- drifted from the real database. This migration is a no-op on any database
-- that already ran 0006 (IF NOT EXISTS) and exists purely to keep
-- drizzle-kit's view of the schema/migration history consistent now that
-- schema.ts declares both indexes explicitly.
CREATE INDEX IF NOT EXISTS idx_audit_logs_event ON audit_logs (event);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at);

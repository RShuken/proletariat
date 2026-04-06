import type Database from 'better-sqlite3'
import type { Migration } from '../migrator.js'

export const webhookProvider: Migration = {
  id: '0023',
  name: 'webhook_provider',
  up: (db: Database.Database) => {
    // SQLite doesn't support ALTER CHECK constraints, so we recreate the table.
    // Preserve all existing data via a temp table swap.
    db.exec(`
      CREATE TABLE notification_providers_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('slack', 'email', 'sms', 'terminal', 'browser_push', 'webhook')),
        name TEXT NOT NULL UNIQUE,
        config TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    db.exec(`
      INSERT INTO notification_providers_new (id, type, name, config, enabled, created_at, updated_at)
      SELECT id, type, name, config, enabled, created_at, updated_at
      FROM notification_providers
    `)

    db.exec(`DROP TABLE notification_providers`)
    db.exec(`ALTER TABLE notification_providers_new RENAME TO notification_providers`)

    // Recreate indexes
    db.exec(`CREATE INDEX IF NOT EXISTS idx_notification_providers_type ON notification_providers(type)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_notification_providers_enabled ON notification_providers(enabled)`)
  },
}

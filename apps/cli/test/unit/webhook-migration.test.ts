import { expect } from 'chai'
import Database from 'better-sqlite3'
import { notificationSystem } from '../../src/lib/database/migrations/0021_notification_system.js'
import { webhookProvider } from '../../src/lib/database/migrations/0023_webhook_provider.js'

/**
 * Tests for migration 0023: webhook_provider — adds 'webhook' to
 * notification_providers type CHECK constraint.
 */
describe('Migration 0023: webhook_provider (TKT-010)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    // Run prerequisite migration
    notificationSystem.up(db)
  })

  afterEach(() => {
    if (db) db.close()
  })

  it('should have correct migration metadata', () => {
    expect(webhookProvider.id).to.equal('0023')
    expect(webhookProvider.name).to.equal('webhook_provider')
  })

  it('should allow inserting webhook provider after migration', () => {
    webhookProvider.up(db)

    expect(() => {
      db.prepare(
        "INSERT INTO notification_providers (id, type, name, config) VALUES ('wh1', 'webhook', 'my-webhook', '{\"url\": \"https://example.com\"}')"
      ).run()
    }).to.not.throw()

    const row = db.prepare('SELECT * FROM notification_providers WHERE id = ?').get('wh1') as any
    expect(row.type).to.equal('webhook')
    expect(row.name).to.equal('my-webhook')
  })

  it('should reject webhook type before migration', () => {
    // Before migration 0023, webhook is not in the CHECK constraint
    expect(() => {
      db.prepare(
        "INSERT INTO notification_providers (id, type, name, config) VALUES ('wh2', 'webhook', 'test', '{}')"
      ).run()
    }).to.throw()
  })

  it('should preserve existing providers during migration', () => {
    // Insert data before migration
    db.prepare(
      "INSERT INTO notification_providers (id, type, name, config) VALUES ('p1', 'slack', 'my-slack', '{\"webhook_url\": \"https://hooks.slack.com/test\"}')"
    ).run()
    db.prepare(
      "INSERT INTO notification_providers (id, type, name, config) VALUES ('p2', 'terminal', 'my-term', '{}')"
    ).run()

    // Run migration
    webhookProvider.up(db)

    // Verify existing data preserved
    const providers = db.prepare('SELECT * FROM notification_providers ORDER BY id').all() as any[]
    expect(providers).to.have.lengthOf(2)
    expect(providers[0].id).to.equal('p1')
    expect(providers[0].type).to.equal('slack')
    expect(providers[1].id).to.equal('p2')
    expect(providers[1].type).to.equal('terminal')
  })

  it('should still reject invalid types after migration', () => {
    webhookProvider.up(db)

    expect(() => {
      db.prepare(
        "INSERT INTO notification_providers (id, type, name, config) VALUES ('bad', 'invalid_type', 'test', '{}')"
      ).run()
    }).to.throw()
  })

  it('should recreate indexes after migration', () => {
    webhookProvider.up(db)

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_notification_providers%'"
    ).all() as Array<{ name: string }>

    const indexNames = indexes.map(i => i.name)
    expect(indexNames).to.include('idx_notification_providers_type')
    expect(indexNames).to.include('idx_notification_providers_enabled')
  })

  it('should still enforce unique provider names after migration', () => {
    webhookProvider.up(db)

    db.prepare(
      "INSERT INTO notification_providers (id, type, name, config) VALUES ('u1', 'webhook', 'unique-name', '{}')"
    ).run()

    expect(() => {
      db.prepare(
        "INSERT INTO notification_providers (id, type, name, config) VALUES ('u2', 'webhook', 'unique-name', '{}')"
      ).run()
    }).to.throw()
  })
})

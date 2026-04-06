import { expect } from 'chai'
import Database from 'better-sqlite3'
import { NotificationStorage } from '../../src/lib/notifications/storage.js'
import { SettingsStore } from '../../src/lib/database/settings-store.js'
import { notificationSystem } from '../../src/lib/database/migrations/0021_notification_system.js'
import { webhookProvider } from '../../src/lib/database/migrations/0023_webhook_provider.js'
import type { WebhookProviderConfig } from '../../src/lib/notifications/types.js'

/**
 * Tests for the notify setup workflow — simulates what the setup command does:
 * saves workspace_settings, creates/updates webhook provider, auto-wires rules.
 *
 * These are unit tests against the storage/settings layer, not full oclif command tests.
 */
describe('Webhook Setup Flow (TKT-010)', () => {
  let db: Database.Database
  let storage: NotificationStorage
  let settings: SettingsStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    // Create workspace_settings table (normally done in baseline migration)
    db.prepare(`
      CREATE TABLE IF NOT EXISTS workspace_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `).run()

    notificationSystem.up(db)
    webhookProvider.up(db)
    storage = new NotificationStorage(db)
    settings = new SettingsStore(db)
  })

  afterEach(() => {
    if (db) db.close()
  })

  // =========================================================================
  // Settings persistence
  // =========================================================================
  describe('workspace_settings persistence', () => {
    it('should save webhook URL to workspace_settings', () => {
      settings.set('webhook.url', 'https://example.com/webhook')
      expect(settings.get('webhook.url')).to.equal('https://example.com/webhook')
    })

    it('should save webhook enabled flag', () => {
      settings.set('webhook.enabled', 'true')
      expect(settings.get('webhook.enabled')).to.equal('true')
    })

    it('should save webhook format', () => {
      settings.set('webhook.format', 'slack')
      expect(settings.get('webhook.format')).to.equal('slack')
    })

    it('should save webhook secret', () => {
      settings.set('webhook.secret', 'my-secret')
      expect(settings.get('webhook.secret')).to.equal('my-secret')
    })

    it('should retrieve all webhook settings by prefix', () => {
      settings.set('webhook.url', 'https://example.com')
      settings.set('webhook.enabled', 'true')
      settings.set('webhook.format', 'generic')

      const webhookSettings = settings.getByPrefix('webhook.')
      expect(webhookSettings).to.have.lengthOf(3)
      expect(webhookSettings.map(s => s.key).sort()).to.deep.equal([
        'webhook.enabled',
        'webhook.format',
        'webhook.url',
      ])
    })
  })

  // =========================================================================
  // Provider creation (setup flow)
  // =========================================================================
  describe('provider creation', () => {
    it('should create a webhook provider during setup', () => {
      const config: WebhookProviderConfig = {
        url: 'https://example.com/webhook',
        format: 'generic',
      }

      const provider = storage.createProvider({ type: 'webhook', name: 'webhook', config })
      expect(provider.type).to.equal('webhook')
      expect(provider.name).to.equal('webhook')
      expect(provider.enabled).to.be.true

      const providerConfig = provider.config as WebhookProviderConfig
      expect(providerConfig.url).to.equal('https://example.com/webhook')
      expect(providerConfig.format).to.equal('generic')
    })

    it('should update existing provider by name during re-setup', () => {
      // First setup
      const original = storage.createProvider({
        type: 'webhook',
        name: 'webhook',
        config: { url: 'https://old.com', format: 'generic' },
      })

      // Re-setup with new URL
      const existing = storage.getProviderByName('webhook')
      expect(existing).to.not.be.null

      storage.updateProvider(existing!.id, {
        config: { url: 'https://new.com', format: 'slack', secret: 'new-key' },
        enabled: true,
      })

      const updated = storage.getProviderById(original.id)!
      const config = updated.config as WebhookProviderConfig
      expect(config.url).to.equal('https://new.com')
      expect(config.format).to.equal('slack')
      expect(config.secret).to.equal('new-key')
    })
  })

  // =========================================================================
  // Auto-wiring rules
  // =========================================================================
  describe('auto-wiring agent lifecycle rules', () => {
    const AGENT_LIFECYCLE_EVENTS = [
      'on_agent_completed',
      'on_agent_died',
      'on_agent_idle',
      'on_agent_needs_input',
    ] as const

    it('should auto-wire rules for all 4 agent lifecycle events', () => {
      const provider = storage.createProvider({
        type: 'webhook',
        name: 'webhook',
        config: { url: 'https://example.com', format: 'generic' },
      })

      for (const event of AGENT_LIFECYCLE_EVENTS) {
        const existingRules = storage.listRules({ event, providerId: provider.id })
        if (existingRules.length === 0) {
          storage.createRule({ event, providerId: provider.id })
        }
      }

      const rules = storage.listRules({ providerId: provider.id })
      expect(rules).to.have.lengthOf(4)

      const ruleEvents = rules.map(r => r.event).sort()
      expect(ruleEvents).to.deep.equal([...AGENT_LIFECYCLE_EVENTS].sort())
    })

    it('should not duplicate rules on re-setup', () => {
      const provider = storage.createProvider({
        type: 'webhook',
        name: 'webhook',
        config: { url: 'https://example.com', format: 'generic' },
      })

      // First setup — wire rules
      for (const event of AGENT_LIFECYCLE_EVENTS) {
        storage.createRule({ event, providerId: provider.id })
      }

      // Second setup — should skip existing
      for (const event of AGENT_LIFECYCLE_EVENTS) {
        const existingRules = storage.listRules({ event, providerId: provider.id })
        if (existingRules.length === 0) {
          storage.createRule({ event, providerId: provider.id })
        }
      }

      const rules = storage.listRules({ providerId: provider.id })
      expect(rules).to.have.lengthOf(4) // Not 8
    })
  })

  // =========================================================================
  // End-to-end setup flow
  // =========================================================================
  describe('full setup flow', () => {
    it('should complete the full setup: settings + provider + rules', () => {
      const url = 'https://hooks.slack.com/services/T/B/x'
      const format = 'slack' as const
      const secret = 'signing-secret'

      // Step 1: Save settings
      settings.set('webhook.url', url)
      settings.set('webhook.enabled', 'true')
      settings.set('webhook.format', format)
      settings.set('webhook.secret', secret)

      // Step 2: Create provider
      const config: WebhookProviderConfig = { url, format, secret }
      const provider = storage.createProvider({ type: 'webhook', name: 'webhook', config })

      // Step 3: Auto-wire rules
      const events = ['on_agent_completed', 'on_agent_died', 'on_agent_idle', 'on_agent_needs_input'] as const
      for (const event of events) {
        storage.createRule({ event, providerId: provider.id })
      }

      // Verify everything is in place
      expect(settings.get('webhook.url')).to.equal(url)
      expect(settings.get('webhook.enabled')).to.equal('true')
      expect(settings.get('webhook.format')).to.equal(format)
      expect(settings.get('webhook.secret')).to.equal(secret)

      const savedProvider = storage.getProviderByName('webhook')!
      expect(savedProvider.type).to.equal('webhook')
      expect(savedProvider.enabled).to.be.true

      const rules = storage.listRules({ providerId: provider.id })
      expect(rules).to.have.lengthOf(4)

      // Verify rules resolve with provider for dispatching
      for (const event of events) {
        const resolved = storage.getRulesWithProviders(event)
        expect(resolved).to.have.lengthOf(1)
        expect(resolved[0].provider.type).to.equal('webhook')
      }
    })
  })
})

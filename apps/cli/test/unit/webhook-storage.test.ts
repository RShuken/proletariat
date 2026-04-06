import { expect } from 'chai'
import Database from 'better-sqlite3'
import { NotificationStorage } from '../../src/lib/notifications/storage.js'
import { notificationSystem } from '../../src/lib/database/migrations/0021_notification_system.js'
import { webhookProvider } from '../../src/lib/database/migrations/0023_webhook_provider.js'
import type { WebhookProviderConfig } from '../../src/lib/notifications/types.js'

/**
 * Tests for webhook provider CRUD through NotificationStorage.
 */
describe('Webhook Storage (TKT-010)', () => {
  let db: Database.Database
  let storage: NotificationStorage

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    notificationSystem.up(db)
    webhookProvider.up(db)
    storage = new NotificationStorage(db)
  })

  afterEach(() => {
    if (db) db.close()
  })

  // =========================================================================
  // Webhook Provider CRUD
  // =========================================================================
  describe('webhook provider CRUD', () => {
    it('should create a webhook provider with generic format', () => {
      const provider = storage.createProvider({
        type: 'webhook',
        name: 'my-webhook',
        config: { url: 'https://example.com/hook', format: 'generic' },
      })

      expect(provider.id).to.be.a('string')
      expect(provider.type).to.equal('webhook')
      expect(provider.name).to.equal('my-webhook')
      expect(provider.enabled).to.equal(true)

      const config = provider.config as WebhookProviderConfig
      expect(config.url).to.equal('https://example.com/hook')
      expect(config.format).to.equal('generic')
    })

    it('should create a webhook provider with slack format and secret', () => {
      const provider = storage.createProvider({
        type: 'webhook',
        name: 'slack-webhook',
        config: {
          url: 'https://hooks.slack.com/services/T/B/x',
          format: 'slack',
          secret: 'my-signing-secret',
        },
      })

      const config = provider.config as WebhookProviderConfig
      expect(config.format).to.equal('slack')
      expect(config.secret).to.equal('my-signing-secret')
    })

    it('should list webhook providers by type', () => {
      storage.createProvider({ type: 'webhook', name: 'wh-1', config: { url: 'https://a.com', format: 'generic' } })
      storage.createProvider({ type: 'webhook', name: 'wh-2', config: { url: 'https://b.com', format: 'slack' } })
      storage.createProvider({ type: 'terminal', name: 'term', config: {} })

      const webhooks = storage.listProviders({ type: 'webhook' })
      expect(webhooks).to.have.lengthOf(2)
      expect(webhooks.every(p => p.type === 'webhook')).to.be.true
    })

    it('should update webhook provider config', () => {
      const provider = storage.createProvider({
        type: 'webhook',
        name: 'updatable',
        config: { url: 'https://old.com', format: 'generic' },
      })

      storage.updateProvider(provider.id, {
        config: { url: 'https://new.com', format: 'slack', secret: 'new-secret' },
      })

      const updated = storage.getProviderById(provider.id)!
      const config = updated.config as WebhookProviderConfig
      expect(config.url).to.equal('https://new.com')
      expect(config.format).to.equal('slack')
      expect(config.secret).to.equal('new-secret')
    })

    it('should cascade delete webhook rules when provider is deleted', () => {
      const provider = storage.createProvider({
        type: 'webhook',
        name: 'del-webhook',
        config: { url: 'https://del.com', format: 'generic' },
      })

      storage.createRule({ event: 'on_agent_completed', providerId: provider.id })
      storage.createRule({ event: 'on_agent_died', providerId: provider.id })

      expect(storage.listRules({ providerId: provider.id })).to.have.lengthOf(2)

      storage.deleteProvider(provider.id)

      expect(storage.listRules({ providerId: provider.id })).to.have.lengthOf(0)
    })
  })

  // =========================================================================
  // Webhook Rules
  // =========================================================================
  describe('webhook rules for agent lifecycle events', () => {
    it('should create rules for all agent lifecycle events', () => {
      const provider = storage.createProvider({
        type: 'webhook',
        name: 'lifecycle-wh',
        config: { url: 'https://events.com', format: 'generic' },
      })

      const events = ['on_agent_completed', 'on_agent_died', 'on_agent_idle', 'on_agent_needs_input'] as const
      for (const event of events) {
        storage.createRule({ event, providerId: provider.id })
      }

      const rules = storage.listRules({ providerId: provider.id })
      expect(rules).to.have.lengthOf(4)
      expect(rules.map(r => r.event).sort()).to.deep.equal([...events].sort())
    })

    it('should resolve webhook rules with provider in getRulesWithProviders', () => {
      const provider = storage.createProvider({
        type: 'webhook',
        name: 'resolved-wh',
        config: { url: 'https://resolve.com', format: 'slack' },
      })

      storage.createRule({ event: 'on_agent_completed', providerId: provider.id })

      const results = storage.getRulesWithProviders('on_agent_completed')
      expect(results).to.have.lengthOf(1)
      expect(results[0].provider.type).to.equal('webhook')
      expect(results[0].provider.name).to.equal('resolved-wh')

      const config = results[0].provider.config as WebhookProviderConfig
      expect(config.url).to.equal('https://resolve.com')
      expect(config.format).to.equal('slack')
    })
  })
})

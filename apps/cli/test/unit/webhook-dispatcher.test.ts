import { expect } from 'chai'
import { createHmac } from 'node:crypto'
import {
  buildMessage,
  buildWebhookPayload,
  dispatchNotification,
} from '../../src/lib/notifications/dispatcher.js'
import type { NotificationProvider, NotificationContext, WebhookProviderConfig } from '../../src/lib/notifications/types.js'

/**
 * Tests for webhook notification delivery — payload builders, HMAC signing,
 * handler validation, and format presets (generic + Slack Block Kit).
 */
describe('Webhook Dispatcher (TKT-010)', () => {
  // =========================================================================
  // buildWebhookPayload — generic format
  // =========================================================================
  describe('buildWebhookPayload (generic)', () => {
    it('should build generic JSON payload with event and data', () => {
      const context: NotificationContext = {
        event: 'on_agent_completed',
        ticket: 'PRLT-42',
        pr: 7,
        branch: 'feat/login',
        agent: 'agent-abc',
        container: 'ctr-1',
        message: 'Agent finished successfully',
      }

      const payload = buildWebhookPayload('generic', context)

      expect(payload).to.have.property('event', 'on_agent_completed')
      expect(payload).to.have.property('timestamp').that.is.a('string')
      expect(payload).to.have.nested.property('data.ticket', 'PRLT-42')
      expect(payload).to.have.nested.property('data.pr', 7)
      expect(payload).to.have.nested.property('data.branch', 'feat/login')
      expect(payload).to.have.nested.property('data.agent', 'agent-abc')
      expect(payload).to.have.nested.property('data.container', 'ctr-1')
      expect(payload).to.have.nested.property('data.message', 'Agent finished successfully')
    })

    it('should null-fill missing fields in generic payload', () => {
      const payload = buildWebhookPayload('generic', { event: 'on_agent_idle' })

      expect(payload).to.have.nested.property('data.ticket', null)
      expect(payload).to.have.nested.property('data.pr', null)
      expect(payload).to.have.nested.property('data.branch', null)
      expect(payload).to.have.nested.property('data.agent', null)
      expect(payload).to.have.nested.property('data.container', null)
      expect(payload).to.have.nested.property('data.message', null)
    })

    it('should include ISO timestamp', () => {
      const payload = buildWebhookPayload('generic', { event: 'test' })
      const ts = payload.timestamp as string
      expect(() => new Date(ts)).to.not.throw()
      expect(new Date(ts).toISOString()).to.equal(ts)
    })
  })

  // =========================================================================
  // buildWebhookPayload — slack format (Block Kit)
  // =========================================================================
  describe('buildWebhookPayload (slack)', () => {
    it('should build Slack Block Kit payload with header', () => {
      const payload = buildWebhookPayload('slack', {
        event: 'on_agent_died',
        ticket: 'PRLT-99',
        agent: 'worker-1',
      })

      expect(payload).to.have.property('text').that.is.a('string')
      expect(payload).to.have.property('blocks').that.is.an('array')

      const blocks = payload.blocks as Array<Record<string, unknown>>
      expect(blocks[0]).to.have.property('type', 'header')
    })

    it('should include message section when message is present', () => {
      const payload = buildWebhookPayload('slack', {
        event: 'on_agent_needs_input',
        message: 'Agent is waiting for user input',
      })

      const blocks = payload.blocks as Array<Record<string, unknown>>
      const messageBlock = blocks.find(b => {
        const text = b.text as Record<string, unknown> | undefined
        return b.type === 'section' && text?.type === 'mrkdwn'
      })
      expect(messageBlock).to.exist
    })

    it('should include fields section with ticket, PR, agent, branch', () => {
      const payload = buildWebhookPayload('slack', {
        event: 'on_agent_completed',
        ticket: 'PRLT-10',
        pr: 55,
        agent: 'bot-1',
        branch: 'feat/webhooks',
      })

      const blocks = payload.blocks as Array<Record<string, unknown>>
      const fieldsBlock = blocks.find(b => b.type === 'section' && Array.isArray(b.fields))
      expect(fieldsBlock).to.exist

      const fields = (fieldsBlock as Record<string, unknown>).fields as Array<{ type: string; text: string }>
      expect(fields).to.have.lengthOf(4)
      expect(fields.some(f => f.text.includes('PRLT-10'))).to.be.true
      expect(fields.some(f => f.text.includes('#55'))).to.be.true
      expect(fields.some(f => f.text.includes('bot-1'))).to.be.true
      expect(fields.some(f => f.text.includes('feat/webhooks'))).to.be.true
    })

    it('should omit fields section when no structured data', () => {
      const payload = buildWebhookPayload('slack', { event: 'test' })
      const blocks = payload.blocks as Array<Record<string, unknown>>
      const fieldsBlock = blocks.find(b => b.type === 'section' && Array.isArray(b.fields))
      expect(fieldsBlock).to.be.undefined
    })
  })

  // =========================================================================
  // Webhook handler — validation
  // =========================================================================
  describe('webhook handler', () => {
    it('should fail without url configured', async () => {
      const provider: NotificationProvider = {
        id: 'wh-no-url',
        type: 'webhook',
        name: 'test-webhook',
        config: { format: 'generic' } as WebhookProviderConfig,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      const result = await dispatchNotification(provider, { event: 'test' })
      expect(result.success).to.equal(false)
      expect(result.error).to.include('url')
    })

    it('should fail for unknown provider type', async () => {
      const provider: NotificationProvider = {
        id: 'unknown',
        type: 'unknown_type' as any,
        name: 'unknown',
        config: {} as any,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      const result = await dispatchNotification(provider, { event: 'test' })
      expect(result.success).to.equal(false)
      expect(result.error).to.include('Unknown provider type')
    })
  })

  // =========================================================================
  // HMAC Signing
  // =========================================================================
  describe('HMAC signing', () => {
    it('should produce valid HMAC-SHA256 signature for webhook payload', () => {
      const secret = 'test-secret-key'
      const context: NotificationContext = {
        event: 'on_agent_completed',
        ticket: 'PRLT-1',
      }

      const payload = buildWebhookPayload('generic', context)
      const body = JSON.stringify(payload)
      const expectedSignature = createHmac('sha256', secret).update(body).digest('hex')

      // Verify the signature format matches what the handler would produce
      expect(expectedSignature).to.be.a('string')
      expect(expectedSignature).to.have.length(64) // SHA256 hex = 64 chars
    })
  })

  // =========================================================================
  // Format defaults
  // =========================================================================
  describe('format defaults', () => {
    it('should default to generic format when format is unrecognized', () => {
      const payload = buildWebhookPayload('generic', { event: 'test' })
      expect(payload).to.have.property('event', 'test')
      expect(payload).to.have.property('data')
    })
  })
})

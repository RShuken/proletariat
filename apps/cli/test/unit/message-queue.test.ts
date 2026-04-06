import { expect } from 'chai'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  createWorkspaceDatabase,
  enqueueMessage,
  enqueueBroadcast,
  getPendingMessages,
  getMessagesForAgent,
  markMessageDelivered,
  markMessageRead,
  getAllPendingMessages,
} from '../../src/lib/database/index.js'

describe('Message Queue (TKT-019)', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-queue-test-'))
    const db = createWorkspaceDatabase(testDir, 'hq', 'test-ws', false)
    db.close()
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  describe('enqueueMessage', () => {
    it('creates a pending message', () => {
      const msg = enqueueMessage(testDir, 'agent-a', 'agent-b', 'hello')
      expect(msg.id).to.be.a('number')
      expect(msg.fromAgent).to.equal('agent-a')
      expect(msg.toAgent).to.equal('agent-b')
      expect(msg.message).to.equal('hello')
      expect(msg.status).to.equal('pending')
    })

    it('creates multiple messages with incrementing IDs', () => {
      const m1 = enqueueMessage(testDir, 'a', 'b', 'first')
      const m2 = enqueueMessage(testDir, 'a', 'b', 'second')
      expect(m2.id).to.be.greaterThan(m1.id)
    })
  })

  describe('enqueueBroadcast', () => {
    it('creates one message per recipient', () => {
      const msgs = enqueueBroadcast(testDir, 'sender', ['agent-1', 'agent-2', 'agent-3'], 'broadcast msg')
      expect(msgs).to.have.length(3)
      expect(msgs.map(m => m.toAgent)).to.deep.equal(['agent-1', 'agent-2', 'agent-3'])
      for (const m of msgs) {
        expect(m.fromAgent).to.equal('sender')
        expect(m.message).to.equal('broadcast msg')
        expect(m.status).to.equal('pending')
      }
    })

    it('returns empty array for no recipients', () => {
      const msgs = enqueueBroadcast(testDir, 'sender', [], 'no one listens')
      expect(msgs).to.deep.equal([])
    })
  })

  describe('getPendingMessages', () => {
    it('returns only pending messages for the specified agent', () => {
      enqueueMessage(testDir, 'a', 'target', 'msg1')
      enqueueMessage(testDir, 'b', 'target', 'msg2')
      enqueueMessage(testDir, 'a', 'other', 'msg3')

      const pending = getPendingMessages(testDir, 'target')
      expect(pending).to.have.length(2)
      expect(pending.every(m => m.toAgent === 'target')).to.be.true
      expect(pending.every(m => m.status === 'pending')).to.be.true
    })

    it('excludes delivered and read messages', () => {
      const m1 = enqueueMessage(testDir, 'a', 'target', 'pending-msg')
      const m2 = enqueueMessage(testDir, 'b', 'target', 'delivered-msg')
      enqueueMessage(testDir, 'c', 'target', 'another-pending')

      markMessageDelivered(testDir, m2.id)

      const pending = getPendingMessages(testDir, 'target')
      expect(pending).to.have.length(2)
      expect(pending.map(m => m.id)).to.include(m1.id)
      expect(pending.map(m => m.id)).to.not.include(m2.id)
    })
  })

  describe('getMessagesForAgent', () => {
    it('returns all messages regardless of status', () => {
      const m1 = enqueueMessage(testDir, 'a', 'target', 'msg1')
      enqueueMessage(testDir, 'b', 'target', 'msg2')

      markMessageDelivered(testDir, m1.id)

      const all = getMessagesForAgent(testDir, 'target')
      expect(all).to.have.length(2)
    })

    it('respects the limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        enqueueMessage(testDir, 'a', 'target', `msg-${i}`)
      }

      const limited = getMessagesForAgent(testDir, 'target', 3)
      expect(limited).to.have.length(3)
    })
  })

  describe('markMessageDelivered', () => {
    it('updates status and sets deliveredAt', () => {
      const msg = enqueueMessage(testDir, 'a', 'b', 'test')
      markMessageDelivered(testDir, msg.id)

      const messages = getMessagesForAgent(testDir, 'b')
      const updated = messages.find(m => m.id === msg.id)!
      expect(updated.status).to.equal('delivered')
      expect(updated.deliveredAt).to.be.a('string')
    })
  })

  describe('markMessageRead', () => {
    it('updates status and sets readAt', () => {
      const msg = enqueueMessage(testDir, 'a', 'b', 'test')
      markMessageRead(testDir, msg.id)

      const messages = getMessagesForAgent(testDir, 'b')
      const updated = messages.find(m => m.id === msg.id)!
      expect(updated.status).to.equal('read')
      expect(updated.readAt).to.be.a('string')
    })
  })

  describe('getAllPendingMessages', () => {
    it('returns all pending messages across all agents', () => {
      enqueueMessage(testDir, 'a', 'agent-1', 'msg1')
      enqueueMessage(testDir, 'b', 'agent-2', 'msg2')
      const m3 = enqueueMessage(testDir, 'c', 'agent-3', 'msg3')

      markMessageDelivered(testDir, m3.id)

      const pending = getAllPendingMessages(testDir)
      expect(pending).to.have.length(2)
      expect(pending.every(m => m.status === 'pending')).to.be.true
    })

    it('orders by agent then by created_at', () => {
      enqueueMessage(testDir, 'a', 'zz-agent', 'late')
      enqueueMessage(testDir, 'b', 'aa-agent', 'early')
      enqueueMessage(testDir, 'c', 'aa-agent', 'second')

      const pending = getAllPendingMessages(testDir)
      expect(pending).to.have.length(3)
      // aa-agent messages should come before zz-agent
      expect(pending[0].toAgent).to.equal('aa-agent')
      expect(pending[1].toAgent).to.equal('aa-agent')
      expect(pending[2].toAgent).to.equal('zz-agent')
    })
  })

  describe('migration idempotency', () => {
    it('message_queue table exists after database creation', () => {
      // The table should exist from migration 0025
      const msg = enqueueMessage(testDir, 'test', 'test', 'it works')
      expect(msg.id).to.be.a('number')
    })
  })
})

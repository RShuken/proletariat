import { expect } from 'chai'
import * as http from 'node:http'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import { createDashboardServer, type DashboardServer } from '../../src/lib/dashboard/server.js'
import { SQLiteStorage } from '../../src/lib/pmo/storage/index.js'

/**
 * E2E tests for atomic task claiming REST API.
 *
 * Uses a real SQLite database and dashboard HTTP server to test
 * the full claim/release/available flow including race conditions.
 */
describe('Atomic Claiming API', function (this: Mocha.Suite) {
  this.timeout(15_000)

  let dashboard: DashboardServer | null = null
  let storage: SQLiteStorage
  let tmpDir: string
  const TEST_PORT = 49152 + Math.floor(Math.random() * 10000)
  const PROJECT_ID = 'test-project'

  function postJson(urlPath: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body)
      const req = http.request({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: urlPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, (res) => {
        let responseBody = ''
        res.on('data', (chunk: Buffer) => { responseBody += chunk })
        res.on('end', () => {
          resolve({ status: res.statusCode!, body: JSON.parse(responseBody) })
        })
      })
      req.on('error', reject)
      req.write(data)
      req.end()
    })
  }

  function getJson(urlPath: string): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: TEST_PORT, path: urlPath }, (res) => {
        let responseBody = ''
        res.on('data', (chunk: Buffer) => { responseBody += chunk })
        res.on('end', () => {
          resolve({ status: res.statusCode!, body: JSON.parse(responseBody) })
        })
      }).on('error', reject)
    })
  }

  beforeEach(async () => {
    // Create a fresh temp database for each test
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prlt-claim-test-'))
    const proletariatDir = path.join(tmpDir, '.proletariat')
    fs.mkdirSync(proletariatDir, { recursive: true })
    const dbPath = path.join(proletariatDir, 'pmo.db')

    storage = new SQLiteStorage(dbPath)

    // Initialize a project with a workflow
    await storage.init(PROJECT_ID, {
      name: 'Test Project',
      columns: ['Backlog', 'Ready', 'In Progress', 'Done'],
    })

    // Create test tickets in the Ready column (statusCategory: 'unstarted')
    await storage.createTicket(PROJECT_ID, { title: 'High priority task', priority: 'P1' })
    await storage.createTicket(PROJECT_ID, { title: 'Medium priority task', priority: 'P2' })
    await storage.createTicket(PROJECT_ID, { title: 'Low priority task', priority: 'P3' })

    // Move tickets to Ready column
    const tickets = await storage.listTickets(PROJECT_ID)
    for (const ticket of tickets) {
      await storage.moveTicket(PROJECT_ID, ticket.id, 'Ready')
    }

    dashboard = await createDashboardServer({
      port: TEST_PORT,
      storage: storage as any,
      projectId: PROJECT_ID,
      projectName: 'Test Project',
    })
  })

  afterEach(async () => {
    if (dashboard) {
      await dashboard.close()
      dashboard = null
    }
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ===========================================================================
  // GET /api/board/available
  // ===========================================================================

  describe('GET /api/board/available', () => {
    it('returns unassigned tickets sorted by priority', async () => {
      const res = await getJson('/api/board/available')
      expect(res.status).to.equal(200)
      expect(res.body.success).to.equal(true)
      const tickets = res.body.tickets as Array<{ id: string; priority: string }>
      expect(tickets).to.have.length(3)
      expect(tickets[0].priority).to.equal('P1')
      expect(tickets[1].priority).to.equal('P2')
      expect(tickets[2].priority).to.equal('P3')
    })

    it('excludes already-assigned tickets', async () => {
      // Claim one ticket first
      const tickets = await storage.listTickets(PROJECT_ID)
      await storage.claimTicket(tickets[0].id, 'agent-alpha')

      const res = await getJson('/api/board/available')
      expect(res.status).to.equal(200)
      const available = res.body.tickets as Array<{ id: string }>
      expect(available).to.have.length(2)
      expect(available.every((t) => t.id !== tickets[0].id)).to.be.true
    })

    it('returns empty array when all tickets are claimed', async () => {
      const tickets = await storage.listTickets(PROJECT_ID)
      for (const ticket of tickets) {
        await storage.claimTicket(ticket.id, 'agent-alpha')
      }

      const res = await getJson('/api/board/available')
      expect(res.status).to.equal(200)
      expect((res.body.tickets as unknown[]).length).to.equal(0)
    })
  })

  // ===========================================================================
  // POST /api/board/:ticketId/claim
  // ===========================================================================

  describe('POST /api/board/:ticketId/claim', () => {
    it('successfully claims an unassigned ticket', async () => {
      const tickets = await storage.listTickets(PROJECT_ID)
      const ticketId = tickets[0].id

      const res = await postJson(`/api/board/${ticketId}/claim`, { agent_name: 'agent-alpha' })
      expect(res.status).to.equal(200)
      expect(res.body.success).to.equal(true)
      expect((res.body.ticket as Record<string, unknown>).assignee).to.equal('agent-alpha')
    })

    it('returns 409 when ticket is already claimed by another agent', async () => {
      const tickets = await storage.listTickets(PROJECT_ID)
      const ticketId = tickets[0].id

      // First claim succeeds
      const first = await postJson(`/api/board/${ticketId}/claim`, { agent_name: 'agent-alpha' })
      expect(first.status).to.equal(200)

      // Second claim by different agent fails
      const second = await postJson(`/api/board/${ticketId}/claim`, { agent_name: 'agent-beta' })
      expect(second.status).to.equal(409)
      expect(second.body.claimed_by).to.equal('agent-alpha')
    })

    it('returns 404 for non-existent ticket', async () => {
      const res = await postJson('/api/board/NONEXISTENT/claim', { agent_name: 'agent-alpha' })
      expect(res.status).to.equal(404)
    })

    it('returns 400 when agent_name is missing', async () => {
      const tickets = await storage.listTickets(PROJECT_ID)
      const res = await postJson(`/api/board/${tickets[0].id}/claim`, {})
      expect(res.status).to.equal(400)
    })

    it('handles race condition — concurrent claims on same ticket', async () => {
      const tickets = await storage.listTickets(PROJECT_ID)
      const ticketId = tickets[0].id

      // Fire both claims concurrently
      const [result1, result2] = await Promise.all([
        postJson(`/api/board/${ticketId}/claim`, { agent_name: 'agent-alpha' }),
        postJson(`/api/board/${ticketId}/claim`, { agent_name: 'agent-beta' }),
      ])

      // Exactly one should succeed (200) and one should fail (409)
      const statuses = [result1.status, result2.status].sort()
      expect(statuses).to.deep.equal([200, 409])

      // Verify the ticket is assigned to exactly one agent
      const ticket = await storage.getTicket(ticketId)
      expect(ticket?.assignee).to.be.oneOf(['agent-alpha', 'agent-beta'])
    })
  })

  // ===========================================================================
  // POST /api/board/:ticketId/release
  // ===========================================================================

  describe('POST /api/board/:ticketId/release', () => {
    it('releases a ticket claimed by the requesting agent', async () => {
      const tickets = await storage.listTickets(PROJECT_ID)
      const ticketId = tickets[0].id

      // Claim first
      await postJson(`/api/board/${ticketId}/claim`, { agent_name: 'agent-alpha' })

      // Release
      const res = await postJson(`/api/board/${ticketId}/release`, { agent_name: 'agent-alpha' })
      expect(res.status).to.equal(200)
      expect(res.body.success).to.equal(true)

      // Verify ticket is now unassigned (undefined — optional field maps SQL NULL to undefined)
      const ticket = await storage.getTicket(ticketId)
      expect(ticket?.assignee).to.not.be.ok
    })

    it('returns 409 when a different agent tries to release', async () => {
      const tickets = await storage.listTickets(PROJECT_ID)
      const ticketId = tickets[0].id

      // Claim as alpha
      await postJson(`/api/board/${ticketId}/claim`, { agent_name: 'agent-alpha' })

      // Beta tries to release — should fail
      const res = await postJson(`/api/board/${ticketId}/release`, { agent_name: 'agent-beta' })
      expect(res.status).to.equal(409)
      expect(res.body.claimed_by).to.equal('agent-alpha')
    })

    it('returns 409 when releasing an unassigned ticket', async () => {
      const tickets = await storage.listTickets(PROJECT_ID)
      const ticketId = tickets[0].id

      const res = await postJson(`/api/board/${ticketId}/release`, { agent_name: 'agent-alpha' })
      expect(res.status).to.equal(409)
    })

    it('returns 404 for non-existent ticket', async () => {
      const res = await postJson('/api/board/NONEXISTENT/release', { agent_name: 'agent-alpha' })
      expect(res.status).to.equal(404)
    })

    it('returns 400 when agent_name is missing', async () => {
      const tickets = await storage.listTickets(PROJECT_ID)
      const res = await postJson(`/api/board/${tickets[0].id}/release`, {})
      expect(res.status).to.equal(400)
    })
  })

  // ===========================================================================
  // Storage-level CAS tests
  // ===========================================================================

  describe('Storage CAS operations', () => {
    it('claimTicket returns claimed:true for unassigned ticket', async () => {
      const tickets = await storage.listTickets(PROJECT_ID)
      const result = await storage.claimTicket(tickets[0].id, 'agent-alpha')
      expect(result.claimed).to.be.true
      expect(result.ticket?.assignee).to.equal('agent-alpha')
    })

    it('claimTicket returns claimed:false for already-assigned ticket', async () => {
      const tickets = await storage.listTickets(PROJECT_ID)
      await storage.claimTicket(tickets[0].id, 'agent-alpha')
      const result = await storage.claimTicket(tickets[0].id, 'agent-beta')
      expect(result.claimed).to.be.false
      expect(result.claimedBy).to.equal('agent-alpha')
    })

    it('claimTicket returns ticket:null for non-existent ticket', async () => {
      const result = await storage.claimTicket('DOES-NOT-EXIST', 'agent-alpha')
      expect(result.claimed).to.be.false
      expect(result.ticket).to.be.null
    })

    it('releaseTicket only works for the current assignee', async () => {
      const tickets = await storage.listTickets(PROJECT_ID)
      await storage.claimTicket(tickets[0].id, 'agent-alpha')

      // Wrong agent can't release
      const wrongRelease = await storage.releaseTicket(tickets[0].id, 'agent-beta')
      expect(wrongRelease.released).to.be.false

      // Right agent can release
      const rightRelease = await storage.releaseTicket(tickets[0].id, 'agent-alpha')
      expect(rightRelease.released).to.be.true
      expect(rightRelease.ticket?.assignee).to.not.be.ok
    })

    it('CAS prevents double-claim at storage level', async () => {
      const tickets = await storage.listTickets(PROJECT_ID)
      const id = tickets[0].id

      // Simulate concurrent claims at storage level
      const results = await Promise.all([
        storage.claimTicket(id, 'agent-1'),
        storage.claimTicket(id, 'agent-2'),
        storage.claimTicket(id, 'agent-3'),
      ])

      const winners = results.filter((r) => r.claimed)
      const losers = results.filter((r) => !r.claimed)

      // Exactly one winner
      expect(winners).to.have.length(1)
      expect(losers).to.have.length(2)

      // Ticket is assigned to exactly one agent
      const ticket = await storage.getTicket(id)
      expect(ticket?.assignee).to.be.oneOf(['agent-1', 'agent-2', 'agent-3'])
    })
  })
})

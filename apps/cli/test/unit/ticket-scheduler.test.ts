import { expect } from 'chai'
import Database from 'better-sqlite3'
import { TicketScheduler, priorityRank, DEFAULT_MAX_AGENTS } from '../../src/lib/orchestrate/scheduler.js'
import { OrchestrateEngine } from '../../src/lib/orchestrate/engine.js'
import { ensureHooksTable } from '../../src/lib/work-lifecycle/hooks/storage.js'
import type { OrchestrateEventContext } from '../../src/lib/orchestrate/types.js'

/**
 * Unit tests for TKT-011: Ticket Scheduler
 *
 * Tests cover:
 * - max_agents capacity enforcement
 * - Priority ordering (P1 before P2 before P3)
 * - Auto-scheduling next ticket when capacity frees up
 * - Deduplication of scheduled tickets
 * - Default max_agents setting
 * - priorityRank helper
 */

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  ensureHooksTable(db)

  try {
    db.exec("ALTER TABLE pmo_work_hooks ADD COLUMN mode TEXT NOT NULL DEFAULT 'auto'")
    db.exec("ALTER TABLE pmo_work_hooks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0")
    db.exec("ALTER TABLE pmo_work_hooks ADD COLUMN project_id TEXT")
    db.exec("ALTER TABLE pmo_work_hooks ADD COLUMN source TEXT NOT NULL DEFAULT 'cli'")
    db.exec("ALTER TABLE pmo_work_hooks ADD COLUMN config TEXT")
  } catch {
    // May already exist
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS pmo_workflow_statuses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS pmo_tickets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status_id TEXT NOT NULL,
      assignee TEXT,
      priority TEXT,
      FOREIGN KEY (status_id) REFERENCES pmo_workflow_statuses(id)
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_work (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'starting',
      lifecycle_state TEXT,
      container_id TEXT,
      last_heartbeat TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS pmo_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  db.prepare("INSERT INTO pmo_workflow_statuses (id, name, category) VALUES ('status-ready', 'Ready', 'unstarted')").run()
  db.prepare("INSERT INTO pmo_workflow_statuses (id, name, category) VALUES ('status-ip', 'In Progress', 'started')").run()
  db.prepare("INSERT INTO pmo_settings (key, value) VALUES ('column_planned', 'Ready')").run()

  return db
}

function createScheduler(db: Database.Database): {
  scheduler: TicketScheduler
  firedEvents: Array<{ event: string; ctx: OrchestrateEventContext }>
} {
  const firedEvents: Array<{ event: string; ctx: OrchestrateEventContext }> = []

  const engine = new OrchestrateEngine({ db, log: () => {} })
  engine.fireEvent = async (event: string, ctx: OrchestrateEventContext) => {
    firedEvents.push({ event, ctx })
    return []
  }

  const scheduler = new TicketScheduler({
    engine,
    db,
    log: () => {},
  })

  return { scheduler, firedEvents }
}

describe('TicketScheduler', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
  })

  afterEach(() => {
    db.close()
  })

  // ===========================================================================
  // max_agents
  // ===========================================================================

  describe('max_agents', () => {
    it('should default to DEFAULT_MAX_AGENTS when no setting exists', () => {
      const { scheduler } = createScheduler(db)
      expect(scheduler.getMaxAgents()).to.equal(DEFAULT_MAX_AGENTS)
    })

    it('should read max_agents from workspace_settings', () => {
      db.prepare("INSERT INTO workspace_settings (key, value) VALUES ('scheduler.max_agents', '5')").run()
      const { scheduler } = createScheduler(db)
      expect(scheduler.getMaxAgents()).to.equal(5)
    })

    it('should fall back to default for invalid values', () => {
      db.prepare("INSERT INTO workspace_settings (key, value) VALUES ('scheduler.max_agents', 'abc')").run()
      const { scheduler } = createScheduler(db)
      expect(scheduler.getMaxAgents()).to.equal(DEFAULT_MAX_AGENTS)
    })

    it('should fall back to default for zero or negative values', () => {
      db.prepare("INSERT INTO workspace_settings (key, value) VALUES ('scheduler.max_agents', '0')").run()
      const { scheduler } = createScheduler(db)
      expect(scheduler.getMaxAgents()).to.equal(DEFAULT_MAX_AGENTS)
    })
  })

  // ===========================================================================
  // Capacity
  // ===========================================================================

  describe('capacity', () => {
    it('should report capacity when no agents running', () => {
      const { scheduler } = createScheduler(db)
      expect(scheduler.hasCapacity()).to.be.true
      expect(scheduler.getRunningAgentCount()).to.equal(0)
    })

    it('should report no capacity when at max_agents', () => {
      db.prepare("INSERT INTO workspace_settings (key, value) VALUES ('scheduler.max_agents', '2')").run()
      db.prepare("INSERT INTO agent_work (id, ticket_id, agent_name, status) VALUES ('aw-1', 'TKT-1', 'agent-1', 'running')").run()
      db.prepare("INSERT INTO agent_work (id, ticket_id, agent_name, status) VALUES ('aw-2', 'TKT-2', 'agent-2', 'running')").run()

      const { scheduler } = createScheduler(db)
      expect(scheduler.hasCapacity()).to.be.false
      expect(scheduler.getRunningAgentCount()).to.equal(2)
    })

    it('should count starting agents towards capacity', () => {
      db.prepare("INSERT INTO workspace_settings (key, value) VALUES ('scheduler.max_agents', '1')").run()
      db.prepare("INSERT INTO agent_work (id, ticket_id, agent_name, status) VALUES ('aw-1', 'TKT-1', 'agent-1', 'starting')").run()

      const { scheduler } = createScheduler(db)
      expect(scheduler.hasCapacity()).to.be.false
    })

    it('should not count completed agents towards capacity', () => {
      db.prepare("INSERT INTO workspace_settings (key, value) VALUES ('scheduler.max_agents', '1')").run()
      db.prepare("INSERT INTO agent_work (id, ticket_id, agent_name, status) VALUES ('aw-1', 'TKT-1', 'agent-1', 'completed')").run()

      const { scheduler } = createScheduler(db)
      expect(scheduler.hasCapacity()).to.be.true
    })
  })

  // ===========================================================================
  // Priority ordering
  // ===========================================================================

  describe('priority ordering', () => {
    it('should return highest-priority ticket first', () => {
      db.prepare("INSERT INTO pmo_tickets (id, title, status_id, assignee, priority) VALUES ('TKT-P3', 'Low', 'status-ready', NULL, 'p3')").run()
      db.prepare("INSERT INTO pmo_tickets (id, title, status_id, assignee, priority) VALUES ('TKT-P1', 'Urgent', 'status-ready', NULL, 'p1')").run()
      db.prepare("INSERT INTO pmo_tickets (id, title, status_id, assignee, priority) VALUES ('TKT-P2', 'Medium', 'status-ready', NULL, 'p2')").run()

      const { scheduler } = createScheduler(db)
      const next = scheduler.getNextReadyTicket()

      expect(next).to.not.be.null
      expect(next!.id).to.equal('TKT-P1')
    })

    it('should handle tickets with no priority (sort last)', () => {
      db.prepare("INSERT INTO pmo_tickets (id, title, status_id, assignee, priority) VALUES ('TKT-NONE', 'No priority', 'status-ready', NULL, NULL)").run()
      db.prepare("INSERT INTO pmo_tickets (id, title, status_id, assignee, priority) VALUES ('TKT-P2', 'Medium', 'status-ready', NULL, 'p2')").run()

      const { scheduler } = createScheduler(db)
      const next = scheduler.getNextReadyTicket()

      expect(next).to.not.be.null
      expect(next!.id).to.equal('TKT-P2')
    })

    it('should handle urgent priority', () => {
      db.prepare("INSERT INTO pmo_tickets (id, title, status_id, assignee, priority) VALUES ('TKT-P1', 'High', 'status-ready', NULL, 'p1')").run()
      db.prepare("INSERT INTO pmo_tickets (id, title, status_id, assignee, priority) VALUES ('TKT-URG', 'Urgent', 'status-ready', NULL, 'urgent')").run()

      const { scheduler } = createScheduler(db)
      const next = scheduler.getNextReadyTicket()

      expect(next).to.not.be.null
      expect(next!.id).to.equal('TKT-URG')
    })

    it('should skip assigned tickets', () => {
      db.prepare("INSERT INTO pmo_tickets (id, title, status_id, assignee, priority) VALUES ('TKT-ASSIGNED', 'Assigned', 'status-ready', 'agent-1', 'p1')").run()
      db.prepare("INSERT INTO pmo_tickets (id, title, status_id, assignee, priority) VALUES ('TKT-FREE', 'Free', 'status-ready', NULL, 'p2')").run()

      const { scheduler } = createScheduler(db)
      const next = scheduler.getNextReadyTicket()

      expect(next).to.not.be.null
      expect(next!.id).to.equal('TKT-FREE')
    })

    it('should skip tickets with active agents', () => {
      db.prepare("INSERT INTO pmo_tickets (id, title, status_id, assignee, priority) VALUES ('TKT-ACTIVE', 'Active', 'status-ready', NULL, 'p1')").run()
      db.prepare("INSERT INTO agent_work (id, ticket_id, agent_name, status) VALUES ('aw-1', 'TKT-ACTIVE', 'agent-1', 'running')").run()
      db.prepare("INSERT INTO pmo_tickets (id, title, status_id, assignee, priority) VALUES ('TKT-IDLE', 'Idle', 'status-ready', NULL, 'p2')").run()

      const { scheduler } = createScheduler(db)
      const next = scheduler.getNextReadyTicket()

      expect(next).to.not.be.null
      expect(next!.id).to.equal('TKT-IDLE')
    })

    it('should return null when no ready tickets', () => {
      const { scheduler } = createScheduler(db)
      const next = scheduler.getNextReadyTicket()
      expect(next).to.be.null
    })
  })

  // ===========================================================================
  // tryScheduleNext
  // ===========================================================================

  describe('tryScheduleNext', () => {
    it('should fire on_ticket_ready for highest-priority ticket when capacity exists', async () => {
      db.prepare("INSERT INTO pmo_tickets (id, title, status_id, assignee, priority) VALUES ('TKT-1', 'First', 'status-ready', NULL, 'p1')").run()
      db.prepare("INSERT INTO pmo_tickets (id, title, status_id, assignee, priority) VALUES ('TKT-2', 'Second', 'status-ready', NULL, 'p2')").run()

      const { scheduler, firedEvents } = createScheduler(db)
      const scheduled = await scheduler.tryScheduleNext()

      expect(scheduled).to.be.true
      expect(firedEvents).to.have.length(1)
      expect(firedEvents[0].event).to.equal('on_ticket_ready')
      expect(firedEvents[0].ctx.ticket).to.equal('TKT-1')
    })

    it('should not fire when at max capacity', async () => {
      db.prepare("INSERT INTO workspace_settings (key, value) VALUES ('scheduler.max_agents', '1')").run()
      db.prepare("INSERT INTO agent_work (id, ticket_id, agent_name, status) VALUES ('aw-1', 'TKT-X', 'agent-1', 'running')").run()
      db.prepare("INSERT INTO pmo_tickets (id, title, status_id, assignee, priority) VALUES ('TKT-1', 'First', 'status-ready', NULL, 'p1')").run()

      const { scheduler, firedEvents } = createScheduler(db)
      const scheduled = await scheduler.tryScheduleNext()

      expect(scheduled).to.be.false
      expect(firedEvents).to.be.empty
    })

    it('should not fire when no ready tickets', async () => {
      const { scheduler, firedEvents } = createScheduler(db)
      const scheduled = await scheduler.tryScheduleNext()

      expect(scheduled).to.be.false
      expect(firedEvents).to.be.empty
    })

    it('should not schedule same ticket twice without clearing', async () => {
      db.prepare("INSERT INTO pmo_tickets (id, title, status_id, assignee, priority) VALUES ('TKT-1', 'First', 'status-ready', NULL, 'p1')").run()

      const { scheduler, firedEvents } = createScheduler(db)
      await scheduler.tryScheduleNext()
      await scheduler.tryScheduleNext()

      expect(firedEvents).to.have.length(1)
    })

    it('should allow re-scheduling after clearScheduledTickets', async () => {
      db.prepare("INSERT INTO pmo_tickets (id, title, status_id, assignee, priority) VALUES ('TKT-1', 'First', 'status-ready', NULL, 'p1')").run()

      const { scheduler, firedEvents } = createScheduler(db)
      await scheduler.tryScheduleNext()
      scheduler.clearScheduledTickets()
      await scheduler.tryScheduleNext()

      expect(firedEvents).to.have.length(2)
    })
  })

  // ===========================================================================
  // priorityRank helper
  // ===========================================================================

  describe('priorityRank', () => {
    it('should rank urgent highest', () => {
      expect(priorityRank('urgent')).to.be.lessThan(priorityRank('p1'))
    })

    it('should rank P1 before P2', () => {
      expect(priorityRank('p1')).to.be.lessThan(priorityRank('p2'))
    })

    it('should rank P2 before P3', () => {
      expect(priorityRank('p2')).to.be.lessThan(priorityRank('p3'))
    })

    it('should rank null last', () => {
      expect(priorityRank(null)).to.be.greaterThan(priorityRank('p3'))
    })

    it('should be case-insensitive', () => {
      expect(priorityRank('P1')).to.equal(priorityRank('p1'))
      expect(priorityRank('HIGH')).to.equal(priorityRank('high'))
    })

    it('should handle string aliases', () => {
      expect(priorityRank('high')).to.equal(priorityRank('p1'))
      expect(priorityRank('medium')).to.equal(priorityRank('p2'))
      expect(priorityRank('low')).to.equal(priorityRank('p3'))
    })

    it('should handle unknown priority as last', () => {
      expect(priorityRank('unknown')).to.equal(99)
    })
  })
})

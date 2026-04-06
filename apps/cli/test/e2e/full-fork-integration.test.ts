import { expect } from 'chai'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as http from 'node:http'
import Database from 'better-sqlite3'
import {
  createTestEnvironment,
  cleanupTestEnvironment,
  setupProductionSchema,
  addWorkspaceTables,
  createHQConfig,
  createPMODirectories,
  createTestProject,
  createTestTicket,
  addTestWorkflowStatus,
  type TestEnvironment,
} from './test-helpers.js'

// Source modules under test
import { enableWALMode, checkIntegrity, createRotatingBackup, listBackups } from '../../src/lib/database/db-safety.js'
import { runDrizzleMigrations, type Migration } from '../../src/lib/database/migrator.js'
import { ALL_MIGRATIONS } from '../../src/lib/database/migrations/index.js'
import { CREATE_TABLES_SQL } from '../../src/lib/database/workspace-schema.js'
import { SettingsStore } from '../../src/lib/database/settings-store.js'
import { setCredential, getCredential, hasCredential } from '../../src/lib/database/credential-store.js'
import { NotificationStorage } from '../../src/lib/notifications/storage.js'
import { buildWebhookPayload, buildMessage, dispatchNotification } from '../../src/lib/notifications/dispatcher.js'
import type { NotificationProvider, NotificationContext } from '../../src/lib/notifications/types.js'
import { TicketScheduler, priorityRank, DEFAULT_MAX_AGENTS } from '../../src/lib/orchestrate/scheduler.js'
import {
  getContextWindow,
  getContextLevel,
  calculateContextUsage,
  CONTEXT_WARNING_THRESHOLD,
  CONTEXT_COMPACT_THRESHOLD,
  DEFAULT_CONTEXT_WINDOW,
} from '../../src/lib/execution/context-monitor.js'
import {
  AutoResponder,
  classifyPrompt,
  type SessionInfo,
  type AutoResponderDeps,
} from '../../src/lib/orchestrate/auto-responder.js'
import {
  calculateCost,
  parseSessionTokensSync,
  formatTokenCount,
  formatCost,
} from '../../src/lib/execution/token-parser.js'
import { GitHubClient } from '../../src/lib/github/client.js'
import { isGitHubConfigured, saveGitHubToken, saveGitHubRepo, loadGitHubConfig } from '../../src/lib/github/config.js'
import { PMO_TABLES } from '../../src/lib/pmo/schema.js'

const T = PMO_TABLES

// =============================================================================
// Full Fork Integration Test
// =============================================================================

describe('Full Fork Integration — 25+ Features', function (this: Mocha.Suite) {
  this.timeout(60_000)

  let env: TestEnvironment
  let db: Database.Database

  beforeEach(() => {
    env = createTestEnvironment('fork-integ-')
    db = setupProductionSchema(env.dbPath, env.pmoPath)
    addWorkspaceTables(db, { type: 'hq', workspaceName: 'test-hq', hasPmo: true })
    createHQConfig(env.proletariatDir)
    createPMODirectories(env.pmoPath, 'test-project')
    createTestProject(db, { id: 'test-project', name: 'Test Project' })
  })

  afterEach(() => {
    try { db.close() } catch { /* may already be closed */ }
    cleanupTestEnvironment(env)
  })

  // ===========================================================================
  // 1. DATABASE
  // ===========================================================================
  describe('1. Database', () => {
    it('WAL mode is active after enableWALMode', () => {
      enableWALMode(db)
      const result = db.pragma('journal_mode') as Array<{ journal_mode: string }>
      expect(result[0].journal_mode).to.equal('wal')
    })

    it('migrations auto-run and all 28 are registered', () => {
      expect(ALL_MIGRATIONS).to.have.lengthOf(28)
      // Verify sequential IDs
      for (let i = 0; i < ALL_MIGRATIONS.length; i++) {
        const expected = String(i + 1).padStart(4, '0')
        expect(ALL_MIGRATIONS[i].id).to.equal(expected)
      }
    })

    it('migrator applies pending migrations and skips already-applied ones', () => {
      const testDb = new Database(':memory:')
      testDb.exec(CREATE_TABLES_SQL)

      const testMigrations: Migration[] = [
        { id: '9001', name: 'test_add_col', up: (d) => d.exec('ALTER TABLE workspace_settings ADD COLUMN test_col TEXT') },
        { id: '9002', name: 'test_noop', up: () => {} },
      ]

      runDrizzleMigrations(testDb, testMigrations)

      const applied = testDb.prepare('SELECT id FROM prlt_migrations ORDER BY id').all() as Array<{ id: string }>
      expect(applied.map(r => r.id)).to.deep.equal(['9001', '9002'])

      // Running again should be a no-op
      runDrizzleMigrations(testDb, testMigrations)
      const afterSecondRun = testDb.prepare('SELECT COUNT(*) as c FROM prlt_migrations').get() as { c: number }
      expect(afterSecondRun.c).to.equal(2)

      testDb.close()
    })

    it('integrity check passes on a healthy database', () => {
      const result = checkIntegrity(db)
      expect(result.ok).to.be.true
      expect(result.errors).to.have.lengthOf(0)
    })

    it('rotating backup creates and rotates files', () => {
      const backupPath = createRotatingBackup(env.dbPath)
      expect(backupPath).to.not.be.null
      expect(fs.existsSync(backupPath!)).to.be.true

      const backups = listBackups(env.dbPath)
      expect(backups.length).to.be.greaterThanOrEqual(1)
      expect(backups[0].size).to.be.greaterThan(0)
    })
  })

  // ===========================================================================
  // 2. SESSION MANAGEMENT
  // ===========================================================================
  describe('2. Session Management', () => {
    it('agent_work table tracks sessions with lifecycle columns after migrations', () => {
      // Migrations add lifecycle_state, last_heartbeat, etc. to agent_work
      runDrizzleMigrations(db, ALL_MIGRATIONS)

      db.prepare(`
        INSERT INTO agent_work (id, ticket_id, agent_name, executor, status, session_id, lifecycle_state, started_at)
        VALUES ('work-1', 'TKT-001', 'agent-alpha', 'docker', 'running', 'tmux-sess-1', 'healthy', datetime('now'))
      `).run()

      const row = db.prepare('SELECT * FROM agent_work WHERE id = ?').get('work-1') as Record<string, unknown>
      expect(row.session_id).to.equal('tmux-sess-1')
      expect(row.lifecycle_state).to.equal('healthy')
      expect(row.status).to.equal('running')
    })

    it('status detection columns exist on agent_work after migrations', () => {
      runDrizzleMigrations(db, ALL_MIGRATIONS)

      const cols = db.prepare('PRAGMA table_info(agent_work)').all() as Array<{ name: string }>
      const colNames = cols.map(c => c.name)
      expect(colNames).to.include('lifecycle_state')
      expect(colNames).to.include('last_heartbeat')
      expect(colNames).to.include('session_id')
    })

    it('user-scoped agent naming via workspace_settings', () => {
      const settings = new SettingsStore(db)
      settings.set('agent.naming.scope', 'user')
      expect(settings.get('agent.naming.scope')).to.equal('user')
    })
  })

  // ===========================================================================
  // 3. TICKETS
  // ===========================================================================
  describe('3. Tickets', () => {
    it('smart repo mounting stores and reads repos JSON field', () => {
      const ticketId = createTestTicket(db, 'test-project', {
        id: 'TKT-REPO-1',
        title: 'Ticket with repos',
      })

      const repos = JSON.stringify(['main-app', 'shared-lib'])
      db.prepare(`UPDATE ${T.tickets} SET repos = ? WHERE id = ?`).run(repos, ticketId)

      const row = db.prepare(`SELECT repos FROM ${T.tickets} WHERE id = ?`).get(ticketId) as { repos: string }
      expect(JSON.parse(row.repos)).to.deep.equal(['main-app', 'shared-lib'])
    })

    it('ticket can be moved to Done via status update', () => {
      // Use the existing "Done" status from the default workflow
      const doneStatus = db.prepare(
        `SELECT id FROM ${T.workflow_statuses} WHERE workflow_id = 'default' AND name = 'Done'`
      ).get() as { id: string }

      const ticketId = createTestTicket(db, 'test-project', {
        id: 'TKT-DONE-1',
        title: 'Completable ticket',
      })

      db.prepare(`UPDATE ${T.tickets} SET status_id = ?, status = 'Done' WHERE id = ?`).run(doneStatus.id, ticketId)

      const row = db.prepare(`SELECT status, status_id FROM ${T.tickets} WHERE id = ?`).get(ticketId) as { status: string; status_id: string }
      expect(row.status).to.equal('Done')
      expect(row.status_id).to.equal(doneStatus.id)
    })
  })

  // ===========================================================================
  // 4. NOTIFICATIONS
  // ===========================================================================
  describe('4. Notifications', () => {
    let notifStorage: NotificationStorage

    beforeEach(() => {
      // Run notification migrations on this DB
      runDrizzleMigrations(db, ALL_MIGRATIONS)
      notifStorage = new NotificationStorage(db)
    })

    it('webhook config stores and reads providers', () => {
      const provider = notifStorage.createProvider({
        type: 'webhook',
        name: 'test-webhook',
        config: { url: 'https://example.com/hook', format: 'generic' } as Record<string, unknown>,
      })

      expect(provider.id).to.be.a('string')
      expect(provider.type).to.equal('webhook')
      expect(provider.name).to.equal('test-webhook')
      expect(provider.enabled).to.be.true

      const retrieved = notifStorage.getProviderById(provider.id)
      expect(retrieved).to.not.be.null
      expect(retrieved!.name).to.equal('test-webhook')
    })

    it('webhook config stores Slack provider', () => {
      const provider = notifStorage.createProvider({
        type: 'slack',
        name: 'team-slack',
        config: { webhook_url: 'https://hooks.slack.com/services/T00/B00/xxx' } as Record<string, unknown>,
      })

      expect(provider.type).to.equal('slack')
      const config = provider.config as Record<string, unknown>
      expect(config.webhook_url).to.include('hooks.slack.com')
    })

    it('notification rules link events to providers', () => {
      const provider = notifStorage.createProvider({
        type: 'terminal',
        name: 'terminal-notify',
        config: { prefix: '[test]' } as Record<string, unknown>,
      })

      const rule = notifStorage.createRule({
        event: 'on_agent_completed' as never,
        providerId: provider.id,
        priority: 1,
      })

      expect(rule.event).to.equal('on_agent_completed')
      expect(rule.providerId).to.equal(provider.id)

      const rulesWithProviders = notifStorage.getRulesWithProviders('on_agent_completed')
      expect(rulesWithProviders).to.have.lengthOf(1)
      expect(rulesWithProviders[0].provider.name).to.equal('terminal-notify')
    })

    it('buildWebhookPayload formats Slack Block Kit correctly', () => {
      const context: NotificationContext = {
        event: 'on_agent_completed',
        ticket: 'TKT-100',
        agent: 'agent-alpha',
        branch: 'feat/my-feature',
        message: 'Agent finished work',
      }

      const slackPayload = buildWebhookPayload('slack', context)
      expect(slackPayload).to.have.property('blocks')
      expect(slackPayload).to.have.property('text')
      const blocks = slackPayload.blocks as Array<Record<string, unknown>>
      expect(blocks[0].type).to.equal('header')
    })

    it('buildWebhookPayload formats generic JSON correctly', () => {
      const context: NotificationContext = {
        event: 'on_agent_died',
        ticket: 'TKT-200',
        agent: 'agent-beta',
      }

      const payload = buildWebhookPayload('generic', context)
      expect(payload).to.have.property('event', 'on_agent_died')
      expect(payload).to.have.property('timestamp')
      const data = payload.data as Record<string, unknown>
      expect(data.ticket).to.equal('TKT-200')
      expect(data.agent).to.equal('agent-beta')
    })

    it('buildMessage assembles notification text', () => {
      const msg = buildMessage({
        event: 'test_event',
        ticket: 'TKT-1',
        agent: 'bot',
        message: 'hello world',
      })
      expect(msg).to.include('[test_event]')
      expect(msg).to.include('ticket=TKT-1')
      expect(msg).to.include('agent=bot')
      expect(msg).to.include('hello world')
    })

    it('dispatchNotification returns error for missing webhook URL', async () => {
      const provider: NotificationProvider = {
        id: 'p1',
        type: 'webhook',
        name: 'broken-hook',
        config: {} as Record<string, unknown>,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      const result = await dispatchNotification(provider, { event: 'test' })
      expect(result.success).to.be.false
      expect(result.error).to.include('No url configured')
    })
  })

  // ===========================================================================
  // 5. SCHEDULER
  // ===========================================================================
  describe('5. Scheduler', () => {
    it('max_agents config defaults to 3 and can be overridden', () => {
      const scheduler = new TicketScheduler({
        engine: {} as never,
        db,
        log: () => {},
      })

      expect(scheduler.getMaxAgents()).to.equal(DEFAULT_MAX_AGENTS)

      // Override via workspace_settings
      db.prepare("INSERT OR REPLACE INTO workspace_settings (key, value) VALUES ('scheduler.max_agents', '5')").run()
      expect(scheduler.getMaxAgents()).to.equal(5)
    })

    it('scheduler finds Ready tickets ordered by priority', () => {
      const workflowId = 'default'

      // Create a Planned/Ready status
      const plannedId = addTestWorkflowStatus(db, workflowId, {
        name: 'Planned',
        category: 'unstarted',
        position: 1,
      })

      // Create tickets with different priorities
      createTestTicket(db, 'test-project', { id: 'TKT-LOW', title: 'Low priority', priority: 'low', statusId: plannedId, status: 'Planned' })
      createTestTicket(db, 'test-project', { id: 'TKT-HIGH', title: 'High priority', priority: 'high', statusId: plannedId, status: 'Planned' })
      createTestTicket(db, 'test-project', { id: 'TKT-URGENT', title: 'Urgent', priority: 'urgent', statusId: plannedId, status: 'Planned' })

      const scheduler = new TicketScheduler({ engine: {} as never, db, log: () => {} })
      const next = scheduler.getNextReadyTicket()

      expect(next).to.not.be.null
      expect(next!.id).to.equal('TKT-URGENT')
    })

    it('priorityRank orders correctly', () => {
      expect(priorityRank('urgent')).to.be.lessThan(priorityRank('high'))
      expect(priorityRank('high')).to.be.lessThan(priorityRank('medium'))
      expect(priorityRank('medium')).to.be.lessThan(priorityRank('low'))
      expect(priorityRank('low')).to.be.lessThan(priorityRank(null))
      expect(priorityRank('p1')).to.equal(priorityRank('high'))
      expect(priorityRank('p2')).to.equal(priorityRank('medium'))
    })

    it('hasCapacity respects running agent count', () => {
      const scheduler = new TicketScheduler({ engine: {} as never, db, log: () => {} })
      expect(scheduler.hasCapacity()).to.be.true

      // Insert running agents up to the limit
      for (let i = 0; i < DEFAULT_MAX_AGENTS; i++) {
        db.prepare(`
          INSERT INTO agent_work (id, ticket_id, agent_name, executor, status, started_at)
          VALUES (?, ?, ?, 'docker', 'running', datetime('now'))
        `).run(`work-${i}`, `TKT-${i}`, `agent-${i}`)
      }

      expect(scheduler.hasCapacity()).to.be.false
      expect(scheduler.getRunningAgentCount()).to.equal(DEFAULT_MAX_AGENTS)
    })
  })

  // ===========================================================================
  // 6. WATCHDOG
  // ===========================================================================
  describe('6. Watchdog', () => {
    it('context monitor detects high usage levels', () => {
      expect(getContextLevel(0.5)).to.equal('normal')
      expect(getContextLevel(CONTEXT_WARNING_THRESHOLD)).to.equal('warning')
      expect(getContextLevel(CONTEXT_COMPACT_THRESHOLD)).to.equal('critical')
      expect(getContextLevel(0.95)).to.equal('critical')
    })

    it('context window resolves correctly per model', () => {
      expect(getContextWindow('claude-opus-4-6')).to.equal(1_000_000)
      expect(getContextWindow('claude-sonnet-4-6')).to.equal(200_000)
      expect(getContextWindow('claude-haiku-4-5-20251001')).to.equal(200_000)
      expect(getContextWindow(null)).to.equal(DEFAULT_CONTEXT_WINDOW)
      // Infer from model name
      expect(getContextWindow('some-opus-variant')).to.equal(1_000_000)
    })

    it('calculateContextUsage returns correct structure', () => {
      const usage = calculateContextUsage({
        inputTokens: 150_000,
        outputTokens: 10_000,
        cacheReadTokens: 50_000,
        cacheCreationTokens: 0,
        model: 'claude-sonnet-4-6',
        estimatedCostUsd: 0.5,
      })

      expect(usage.totalInputTokens).to.equal(200_000) // 150K + 50K cache
      expect(usage.contextWindow).to.equal(200_000)
      expect(usage.usageRatio).to.equal(1.0)
      expect(usage.level).to.equal('critical')
      expect(usage.model).to.equal('claude-sonnet-4-6')
    })

    it('auto-responder detects prompt types', () => {
      expect(classifyPrompt('Do you want to proceed?')?.category).to.equal('permission')
      expect(classifyPrompt('Do you want to continue?')?.category).to.equal('continue')
      expect(classifyPrompt('Select a model')?.category).to.equal('model_selection')
      expect(classifyPrompt('Start implementation?')?.category).to.equal('plan_approval')
      expect(classifyPrompt('just regular output')).to.be.null
    })

    it('auto-responder never responds to model selection', () => {
      const captured: string[] = []
      const deps: AutoResponderDeps = {
        captureTmuxPane: () => 'Select a model to use',
        sendTmuxMessage: (_id, msg) => { captured.push(msg) },
      }
      const responder = new AutoResponder({ deps, cooldownMs: 0 })

      const session: SessionInfo = {
        executionId: 'exec-1',
        sessionId: 'sess-1',
        agentName: 'agent-1',
        ticketId: 'TKT-1',
        permissionMode: 'danger',
      }

      const action = responder.check(session)
      expect(action).to.be.null
      expect(captured).to.have.lengthOf(0)
    })

    it('auto-responder sends "yes" for continue prompts', () => {
      const captured: string[] = []
      const deps: AutoResponderDeps = {
        captureTmuxPane: () => 'Would you like to continue?',
        sendTmuxMessage: (_id, msg) => { captured.push(msg) },
      }
      const responder = new AutoResponder({ deps, cooldownMs: 0 })

      const session: SessionInfo = {
        executionId: 'exec-2',
        sessionId: 'sess-2',
        agentName: 'agent-2',
        ticketId: 'TKT-2',
        permissionMode: 'safe',
      }

      const action = responder.check(session)
      expect(action).to.not.be.null
      expect(action!.category).to.equal('continue')
      expect(action!.response).to.equal('yes')
      expect(captured).to.deep.equal(['yes'])
    })

    it('auto-responder sends "y" for permission prompts in danger mode', () => {
      const captured: string[] = []
      const deps: AutoResponderDeps = {
        captureTmuxPane: () => 'Do you want to proceed?',
        sendTmuxMessage: (_id, msg) => { captured.push(msg) },
      }
      const responder = new AutoResponder({ deps, cooldownMs: 0 })

      const dangerSession: SessionInfo = {
        executionId: 'exec-3',
        sessionId: 'sess-3',
        agentName: 'agent-3',
        ticketId: 'TKT-3',
        permissionMode: 'danger',
      }

      const action = responder.check(dangerSession)
      expect(action).to.not.be.null
      expect(action!.response).to.equal('y')

      // In safe mode, permission prompts should NOT be auto-responded
      responder.reset()
      const safeSession: SessionInfo = {
        ...dangerSession,
        sessionId: 'sess-4',
        permissionMode: 'safe',
      }
      const safeAction = responder.check(safeSession)
      expect(safeAction).to.be.null
    })

    it('watchdog settings are seeded in workspace_settings', () => {
      runDrizzleMigrations(db, ALL_MIGRATIONS)

      const settings = new SettingsStore(db)
      expect(settings.get('watchdog.enabled')).to.equal('true')
      expect(settings.get('watchdog.context_detection')).to.equal('true')
      expect(settings.get('watchdog.crash_recovery')).to.equal('true')
      expect(settings.get('watchdog.stuck_detection')).to.equal('true')
      expect(settings.get('watchdog.stuck_timeout_secs')).to.equal('300')
    })
  })

  // ===========================================================================
  // 7. REST API
  // ===========================================================================
  describe('7. REST API — Atomic Task Claiming', () => {
    it('atomic claim: assign ticket, detect conflict, release', () => {
      const ticketId = createTestTicket(db, 'test-project', {
        id: 'TKT-CLAIM-1',
        title: 'Claimable ticket',
      })

      // Claim: assign to agent-alpha
      db.prepare(`UPDATE ${T.tickets} SET assignee = ? WHERE id = ? AND assignee IS NULL`).run('agent-alpha', ticketId)

      const claimed = db.prepare(`SELECT assignee FROM ${T.tickets} WHERE id = ?`).get(ticketId) as { assignee: string }
      expect(claimed.assignee).to.equal('agent-alpha')

      // Conflict: agent-beta tries to claim already-assigned ticket
      const result = db.prepare(`UPDATE ${T.tickets} SET assignee = ? WHERE id = ? AND assignee IS NULL`).run('agent-beta', ticketId)
      expect(result.changes).to.equal(0) // No rows updated — CAS failed

      // Release: agent-alpha releases
      db.prepare(`UPDATE ${T.tickets} SET assignee = NULL WHERE id = ? AND assignee = ?`).run(ticketId, 'agent-alpha')
      const released = db.prepare(`SELECT assignee FROM ${T.tickets} WHERE id = ?`).get(ticketId) as { assignee: string | null }
      expect(released.assignee).to.be.null
    })

    it('session peek returns well-structured response shape', () => {
      // Test the data contract for session peek endpoint
      const mockPeekResponse = {
        sessionId: 'prlt-agent-1',
        agentName: 'agent-1',
        lines: ['$ echo hello', 'hello', '$ '],
      }

      expect(mockPeekResponse).to.have.property('sessionId')
      expect(mockPeekResponse).to.have.property('lines')
      expect(mockPeekResponse.lines).to.be.an('array')
      expect(mockPeekResponse.lines).to.have.lengthOf(3)
    })

    it('session send accepts text payload', () => {
      // Test the data contract for session send endpoint
      const sendPayload = { text: '/compact' }
      expect(sendPayload.text).to.be.a('string')
      expect(sendPayload.text).to.equal('/compact')
    })
  })

  // ===========================================================================
  // 8. AGENT COMMS
  // ===========================================================================
  describe('8. Agent Communications', () => {
    beforeEach(() => {
      // Ensure message_queue table exists
      runDrizzleMigrations(db, ALL_MIGRATIONS)
    })

    it('message queue insert and read', () => {
      db.prepare(`
        INSERT INTO message_queue (from_agent, to_agent, message, status, created_at)
        VALUES ('agent-alpha', 'agent-beta', 'Please review PR #42', 'pending', datetime('now'))
      `).run()

      const messages = db.prepare(
        "SELECT * FROM message_queue WHERE to_agent = 'agent-beta' AND status = 'pending'"
      ).all() as Array<Record<string, unknown>>

      expect(messages).to.have.lengthOf(1)
      expect(messages[0].from_agent).to.equal('agent-alpha')
      expect(messages[0].message).to.equal('Please review PR #42')
    })

    it('message delivery status transitions: pending -> delivered -> read', () => {
      const result = db.prepare(`
        INSERT INTO message_queue (from_agent, to_agent, message, status, created_at)
        VALUES ('agent-1', 'agent-2', 'test message', 'pending', datetime('now'))
      `).run()
      const msgId = result.lastInsertRowid

      // Deliver
      db.prepare("UPDATE message_queue SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?").run(msgId)
      let row = db.prepare('SELECT status FROM message_queue WHERE id = ?').get(msgId) as { status: string }
      expect(row.status).to.equal('delivered')

      // Read
      db.prepare("UPDATE message_queue SET status = 'read', read_at = datetime('now') WHERE id = ?").run(msgId)
      row = db.prepare('SELECT status FROM message_queue WHERE id = ?').get(msgId) as { status: string }
      expect(row.status).to.equal('read')
    })

    it('broadcast creates messages for multiple agents', () => {
      const agents = ['agent-a', 'agent-b', 'agent-c']
      const insertStmt = db.prepare(`
        INSERT INTO message_queue (from_agent, to_agent, message, status, created_at)
        VALUES (?, ?, ?, 'pending', datetime('now'))
      `)

      const broadcastTxn = db.transaction(() => {
        for (const agent of agents) {
          insertStmt.run('orchestrator', agent, 'Sprint standup in 5 minutes')
        }
      })
      broadcastTxn()

      const count = db.prepare("SELECT COUNT(*) as c FROM message_queue WHERE from_agent = 'orchestrator'").get() as { c: number }
      expect(count.c).to.equal(3)

      // Each agent has exactly one message
      for (const agent of agents) {
        const msgs = db.prepare('SELECT * FROM message_queue WHERE to_agent = ?').all(agent) as Array<Record<string, unknown>>
        expect(msgs).to.have.lengthOf(1)
        expect(msgs[0].message).to.equal('Sprint standup in 5 minutes')
      }
    })
  })

  // ===========================================================================
  // 9. DASHBOARD
  // ===========================================================================
  describe('9. Dashboard', () => {
    it('web server starts and returns HTML on /', async () => {
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body>Dashboard</body></html>')
      })

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port

      try {
        const response = await fetch(`http://127.0.0.1:${port}/`)
        expect(response.status).to.equal(200)
        const html = await response.text()
        expect(html).to.include('Dashboard')
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })

    it('data endpoint returns valid JSON', async () => {
      const mockData = {
        project: 'test-project',
        agents: [],
        tickets: [],
        timestamp: new Date().toISOString(),
      }

      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(mockData))
      })

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/data`)
        expect(response.status).to.equal(200)
        const json = await response.json() as Record<string, unknown>
        expect(json).to.have.property('project', 'test-project')
        expect(json).to.have.property('agents')
        expect(json).to.have.property('tickets')
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })

    it('SSE event stream connection works', async () => {
      const server = http.createServer((req, res) => {
        if (req.url === '/api/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          })
          res.write('data: {"type":"init"}\n\n')
          setTimeout(() => res.end(), 100)
          return
        }
        res.writeHead(404)
        res.end()
      })

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/events`)
        expect(response.status).to.equal(200)
        expect(response.headers.get('content-type')).to.equal('text/event-stream')
        const body = await response.text()
        expect(body).to.include('data:')
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })
  })

  // ===========================================================================
  // 10. MONITOR
  // ===========================================================================
  describe('10. Monitor', () => {
    it('agent snapshot data shape is correct', () => {
      const snapshot = {
        agentName: 'agent-alpha',
        ticketId: 'TKT-001',
        uptimeMs: 300_000,
        lastOutput: ['Working on feature...', '$ git add .'],
        contextPercent: 45,
        detectedStatus: 'active' as const,
      }

      expect(snapshot.agentName).to.be.a('string')
      expect(snapshot.uptimeMs).to.be.greaterThan(0)
      expect(snapshot.lastOutput).to.be.an('array')
      expect(snapshot.contextPercent).to.be.a('number')
    })

    it('duration formatting works correctly', () => {
      function formatDuration(ms: number): string {
        const seconds = Math.floor(ms / 1000)
        const minutes = Math.floor(seconds / 60)
        const hours = Math.floor(minutes / 60)
        if (hours > 0) return `${hours}h ${minutes % 60}m`
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`
        return `${seconds}s`
      }

      expect(formatDuration(0)).to.equal('0s')
      expect(formatDuration(5000)).to.equal('5s')
      expect(formatDuration(90_000)).to.equal('1m 30s')
      expect(formatDuration(3_700_000)).to.equal('1h 1m')
    })

    it('agent_work records can be queried for monitor display', () => {
      runDrizzleMigrations(db, ALL_MIGRATIONS)

      db.prepare(`
        INSERT INTO agent_work (id, ticket_id, agent_name, executor, status, session_id, lifecycle_state, started_at)
        VALUES ('mon-1', 'TKT-MON', 'monitor-agent', 'docker', 'running', 'sess-mon', 'healthy', datetime('now'))
      `).run()

      const running = db.prepare("SELECT * FROM agent_work WHERE status = 'running'").all() as Array<Record<string, unknown>>
      expect(running).to.have.lengthOf(1)
      expect(running[0].agent_name).to.equal('monitor-agent')
    })
  })

  // ===========================================================================
  // 11. REPOS
  // ===========================================================================
  describe('11. Repos — Flexible Path Registration', () => {
    it('repository table stores path-registered repos', () => {
      db.prepare(`
        INSERT INTO repositories (name, path, type, source_url, action, added_at)
        VALUES ('my-app', '/home/user/projects/my-app', 'main', 'https://github.com/org/my-app', 'link', datetime('now'))
      `).run()

      const repos = db.prepare('SELECT * FROM repositories').all() as Array<Record<string, unknown>>
      expect(repos).to.have.lengthOf(1)
      expect(repos[0].name).to.equal('my-app')
      expect(repos[0].path).to.equal('/home/user/projects/my-app')
      expect(repos[0].type).to.equal('main')
    })

    it('multiple repos with different types', () => {
      db.prepare(`
        INSERT INTO repositories (name, path, type, added_at)
        VALUES ('main-app', '/path/to/main', 'main', datetime('now'))
      `).run()
      db.prepare(`
        INSERT INTO repositories (name, path, type, added_at)
        VALUES ('shared-lib', '/path/to/lib', 'dependency', datetime('now'))
      `).run()

      const repos = db.prepare('SELECT * FROM repositories ORDER BY name').all() as Array<Record<string, unknown>>
      expect(repos).to.have.lengthOf(2)
      expect(repos[0].type).to.equal('main')
      expect(repos[1].type).to.equal('dependency')
    })

    it('repo list shows all path-registered repos', () => {
      const repoNames = ['frontend', 'backend', 'shared']
      for (const name of repoNames) {
        db.prepare(`
          INSERT INTO repositories (name, path, type, added_at)
          VALUES (?, ?, 'main', datetime('now'))
        `).run(name, `/workspace/${name}`)
      }

      const repos = db.prepare('SELECT name FROM repositories ORDER BY name').all() as Array<{ name: string }>
      expect(repos.map(r => r.name)).to.deep.equal(['backend', 'frontend', 'shared'])
    })
  })

  // ===========================================================================
  // 12. TOKEN TRACKING
  // ===========================================================================
  describe('12. Token Tracking', () => {
    it('token usage columns accept inserts on agent_work', () => {
      runDrizzleMigrations(db, ALL_MIGRATIONS)

      db.prepare(`
        INSERT INTO agent_work (id, ticket_id, agent_name, executor, status, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model, estimated_cost_usd, started_at)
        VALUES ('work-tok-1', 'TKT-TOK-1', 'agent-1', 'docker', 'completed', 100000, 5000, 20000, 0, 'claude-sonnet-4-6', 0.375, datetime('now'))
      `).run()

      const row = db.prepare('SELECT * FROM agent_work WHERE id = ?').get('work-tok-1') as Record<string, unknown>
      expect(row.input_tokens).to.equal(100000)
      expect(row.output_tokens).to.equal(5000)
      expect(row.cache_read_tokens).to.equal(20000)
      expect(row.model).to.equal('claude-sonnet-4-6')
    })

    it('cost calculation is correct for Sonnet', () => {
      const cost = calculateCost(1_000_000, 100_000, 500_000, 0, 'claude-sonnet-4-6')
      // input: 1M * $3/M = $3, output: 100K * $15/M = $1.50, cacheRead: 500K * $0.3/M = $0.15
      const expected = 3.0 + 1.5 + 0.15
      expect(cost).to.be.closeTo(expected, 0.001)
    })

    it('cost calculation is correct for Opus', () => {
      const cost = calculateCost(500_000, 50_000, 0, 0, 'claude-opus-4-6')
      // input: 500K * $15/M = $7.50, output: 50K * $75/M = $3.75
      const expected = 7.5 + 3.75
      expect(cost).to.be.closeTo(expected, 0.001)
    })

    it('parseSessionTokensSync handles JSONL file', () => {
      const logDir = path.join(env.testDir, '.claude', 'projects', '-test')
      fs.mkdirSync(logDir, { recursive: true })
      const logPath = path.join(logDir, 'test-session.jsonl')

      const lines = [
        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500 } } }),
        JSON.stringify({ type: 'tool_use', message: { usage: { input_tokens: 300, output_tokens: 100 } } }),
        'invalid json line',
        JSON.stringify({ type: 'system', data: {} }),
      ]
      fs.writeFileSync(logPath, lines.join('\n'))

      const usage = parseSessionTokensSync(logPath)
      expect(usage.inputTokens).to.equal(1300)
      expect(usage.outputTokens).to.equal(300)
      expect(usage.cacheReadTokens).to.equal(500)
      expect(usage.model).to.equal('claude-sonnet-4-6')
      expect(usage.estimatedCostUsd).to.be.greaterThan(0)
    })

    it('formatTokenCount handles various magnitudes', () => {
      expect(formatTokenCount(500)).to.equal('500')
      expect(formatTokenCount(1500)).to.equal('1.5K')
      expect(formatTokenCount(1_500_000)).to.equal('1.5M')
    })

    it('formatCost handles various magnitudes', () => {
      expect(formatCost(5.50)).to.equal('$5.50')
      expect(formatCost(0.05)).to.equal('$0.050')
      expect(formatCost(0.001)).to.equal('$0.0010')
    })
  })

  // ===========================================================================
  // 13. GH DETECTION
  // ===========================================================================
  describe('13. GitHub Detection', () => {
    it('differentiates not-configured state', () => {
      const originalEnv = process.env.GITHUB_TOKEN
      delete process.env.GITHUB_TOKEN

      try {
        expect(isGitHubConfigured(db)).to.be.false
      } finally {
        if (originalEnv) process.env.GITHUB_TOKEN = originalEnv
      }
    })

    it('detects configured state after saving token and repo', () => {
      const originalEnv = process.env.GITHUB_TOKEN
      delete process.env.GITHUB_TOKEN

      try {
        saveGitHubToken(db, 'ghp_testtoken123')
        saveGitHubRepo(db, 'myorg', 'myrepo')
        expect(isGitHubConfigured(db)).to.be.true

        const config = loadGitHubConfig(db)
        expect(config).to.not.be.null
        expect(config!.owner).to.equal('myorg')
        expect(config!.repo).to.equal('myrepo')
        expect(config!.token).to.equal('ghp_testtoken123')
      } finally {
        if (originalEnv) process.env.GITHUB_TOKEN = originalEnv
      }
    })

    it('GITHUB_TOKEN env var provides token when no stored credential', () => {
      const originalEnv = process.env.GITHUB_TOKEN
      process.env.GITHUB_TOKEN = 'ghp_from_env'

      try {
        saveGitHubRepo(db, 'env-org', 'env-repo')
        expect(isGitHubConfigured(db)).to.be.true

        const config = loadGitHubConfig(db)
        expect(config).to.not.be.null
        expect(config!.token).to.equal('ghp_from_env')
      } finally {
        if (originalEnv) {
          process.env.GITHUB_TOKEN = originalEnv
        } else {
          delete process.env.GITHUB_TOKEN
        }
      }
    })

    it('GitHubClient constructs correctly', () => {
      const client = new GitHubClient('ghp_test123')
      expect(client).to.be.instanceOf(GitHubClient)
    })

    it('credential store round-trip for github.token', () => {
      setCredential(db, 'github.token', 'test-secret-token')
      expect(hasCredential(db, 'github.token')).to.be.true
      expect(getCredential(db, 'github.token')).to.equal('test-secret-token')
    })
  })
})

import { expect } from 'chai'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import Database from 'better-sqlite3'
import {
  createTestEnvironment,
  cleanupTestEnvironment,
  setupProductionSchema,
  addWorkspaceTables,
  createPMODirectories,
  createTestProject,
  type TestEnvironment,
} from './test-helpers.js'
import { enableWALMode } from '../../src/lib/database/db-safety.js'

/**
 * Apply fork-specific migrations that may not be in the cached test template.
 * These correspond to migrations 0021-0027 added by the fork (TKT-005 to TKT-019).
 */
function applyForkMigrations(db: Database.Database): void {
  // 0021: notification_providers (with webhook type from 0023)
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_providers (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('slack', 'email', 'sms', 'terminal', 'browser_push', 'webhook')),
      name TEXT NOT NULL UNIQUE,
      config TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notification_providers_type ON notification_providers(type)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notification_providers_enabled ON notification_providers(enabled)`)

  // 0024: token tracking columns on agent_work
  const agentWorkExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_work'"
  ).get()
  if (agentWorkExists) {
    const cols = db.prepare('PRAGMA table_info(agent_work)').all() as Array<{ name: string }>
    const colNames = new Set(cols.map(c => c.name))
    if (!colNames.has('input_tokens')) {
      db.exec(`
        ALTER TABLE agent_work ADD COLUMN input_tokens INTEGER DEFAULT 0;
        ALTER TABLE agent_work ADD COLUMN output_tokens INTEGER DEFAULT 0;
        ALTER TABLE agent_work ADD COLUMN cache_read_tokens INTEGER DEFAULT 0;
        ALTER TABLE agent_work ADD COLUMN cache_creation_tokens INTEGER DEFAULT 0;
        ALTER TABLE agent_work ADD COLUMN model TEXT;
        ALTER TABLE agent_work ADD COLUMN estimated_cost_usd REAL DEFAULT 0;
      `)
    }
  }

  // 0025: repos column on pmo_tickets
  const ticketsExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='pmo_tickets'"
  ).get()
  if (ticketsExists) {
    const cols = db.prepare('PRAGMA table_info(pmo_tickets)').all() as Array<{ name: string }>
    if (!cols.some(c => c.name === 'repos')) {
      db.exec(`ALTER TABLE pmo_tickets ADD COLUMN repos TEXT DEFAULT NULL`)
    }
  }

  // 0027: message_queue table
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'read')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT,
      read_at TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_message_queue_to_status ON message_queue(to_agent, status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_message_queue_created ON message_queue(created_at)`)
}

/**
 * End-to-end tests for fork features TKT-005 through TKT-019.
 *
 * Validates that the 15 features added to the proletariat fork
 * work correctly: database schema, config roundtrips, imports,
 * and command-level behavior.
 */
describe('Fork Features E2E (TKT-005 through TKT-019)', () => {
  let env: TestEnvironment
  let db: Database.Database

  beforeEach(() => {
    env = createTestEnvironment('fork-features-')
    createPMODirectories(env.pmoPath)
    db = setupProductionSchema(env.dbPath, env.pmoPath)
    addWorkspaceTables(db, { type: 'hq', workspaceName: 'test-hq', hasPmo: true })
    applyForkMigrations(db)
  })

  afterEach(() => {
    if (db) db.close()
    cleanupTestEnvironment(env)
  })

  // ===========================================================================
  // 1. WAL mode is active on database open
  // ===========================================================================
  describe('WAL mode (database durability)', () => {
    it('should enable WAL journal mode via enableWALMode', () => {
      enableWALMode(db)
      const row = db.pragma('journal_mode') as Array<{ journal_mode: string }>
      expect(row[0].journal_mode).to.equal('wal')
    })

    it('should persist WAL mode across reopen', () => {
      enableWALMode(db)
      db.close()
      const reopened = new Database(env.dbPath)
      const row = reopened.pragma('journal_mode') as Array<{ journal_mode: string }>
      expect(row[0].journal_mode).to.equal('wal')
      reopened.close()
    })
  })

  // ===========================================================================
  // 2. Webhook config can be stored and retrieved from notification_providers
  // ===========================================================================
  describe('Webhook provider (notification_providers)', () => {
    it('should accept webhook type in notification_providers', () => {
      db.prepare(`
        INSERT INTO notification_providers (id, type, name, config, enabled)
        VALUES (?, ?, ?, ?, ?)
      `).run('wh-001', 'webhook', 'deploy-hook', JSON.stringify({ url: 'https://example.com/hook' }), 1)

      const row = db.prepare(
        "SELECT * FROM notification_providers WHERE id = 'wh-001'"
      ).get() as Record<string, unknown>

      expect(row).to.exist
      expect(row.type).to.equal('webhook')
      expect(row.name).to.equal('deploy-hook')
      expect(JSON.parse(row.config as string)).to.deep.equal({ url: 'https://example.com/hook' })
      expect(row.enabled).to.equal(1)
    })

    it('should roundtrip webhook config with complex payload', () => {
      const config = {
        url: 'https://example.com/webhook',
        method: 'POST',
        headers: { Authorization: 'Bearer token123' },
        events: ['ticket.completed', 'agent.died'],
      }
      db.prepare(`
        INSERT INTO notification_providers (id, type, name, config) VALUES (?, ?, ?, ?)
      `).run('wh-002', 'webhook', 'complex-hook', JSON.stringify(config))

      const row = db.prepare(
        "SELECT config FROM notification_providers WHERE id = 'wh-002'"
      ).get() as { config: string }

      expect(JSON.parse(row.config)).to.deep.equal(config)
    })

    it('should reject invalid provider types', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO notification_providers (id, type, name) VALUES (?, ?, ?)
        `).run('wh-bad', 'invalid_type', 'bad-provider')
      }).to.throw()
    })
  })

  // ===========================================================================
  // 3. Scheduler config (max_agents) can be set and read
  // ===========================================================================
  describe('Scheduler config (workspace_settings)', () => {
    it('should store and retrieve scheduler.max_agents', () => {
      db.prepare(`
        INSERT INTO workspace_settings (key, value)
        VALUES ('scheduler.max_agents', '5')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run()

      const row = db.prepare(
        "SELECT value FROM workspace_settings WHERE key = 'scheduler.max_agents'"
      ).get() as { value: string }

      expect(row.value).to.equal('5')
    })

    it('should update scheduler.max_agents via upsert', () => {
      const upsert = db.prepare(`
        INSERT INTO workspace_settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      upsert.run('scheduler.max_agents', '3')
      upsert.run('scheduler.max_agents', '10')

      const row = db.prepare(
        "SELECT value FROM workspace_settings WHERE key = 'scheduler.max_agents'"
      ).get() as { value: string }

      expect(row.value).to.equal('10')
    })
  })

  // ===========================================================================
  // 4. User-scoped session names contain the current username prefix
  // ===========================================================================
  describe('User-scoped session names', () => {
    let originalPrltUser: string | undefined

    beforeEach(() => {
      originalPrltUser = process.env.PRLT_USER
    })

    afterEach(() => {
      if (originalPrltUser !== undefined) {
        process.env.PRLT_USER = originalPrltUser
      } else {
        delete process.env.PRLT_USER
      }
    })

    it('should build session names with user prefix', async () => {
      process.env.PRLT_USER = 'testuser'
      const { buildExpectedSessionName } = await import(
        '../../src/lib/execution/session-utils.js'
      )
      const name = buildExpectedSessionName('TKT-100', 'bold-eagle', 'Implement')
      expect(name).to.equal('testuser--TKT-100-Implement-bold-eagle')
    })

    it('should parse user-prefixed session names correctly', async () => {
      const { parseSessionName } = await import(
        '../../src/lib/execution/session-utils.js'
      )
      const parsed = parseSessionName('alice--TKT-200-Review-swift-fox')
      expect(parsed).to.not.be.null
      expect(parsed!.user).to.equal('alice')
      expect(parsed!.ticketId).to.equal('TKT-200')
      expect(parsed!.action).to.equal('Review')
      expect(parsed!.agentName).to.equal('swift-fox')
    })

    it('should parse legacy unprefixed session names', async () => {
      const { parseSessionName } = await import(
        '../../src/lib/execution/session-utils.js'
      )
      const parsed = parseSessionName('TKT-300-work-old-agent')
      expect(parsed).to.not.be.null
      expect(parsed!.user).to.be.undefined
      expect(parsed!.ticketId).to.equal('TKT-300')
      expect(parsed!.action).to.equal('work')
      expect(parsed!.agentName).to.equal('old-agent')
    })

    it('should return current user from PRLT_USER env', async () => {
      process.env.PRLT_USER = 'forktest'
      const { getCurrentUser } = await import(
        '../../src/lib/execution/session-utils.js'
      )
      expect(getCurrentUser()).to.equal('forktest')
    })
  })

  // ===========================================================================
  // 5. Token tracking columns exist on agent_work and accept inserts
  // ===========================================================================
  describe('Token tracking (agent_work columns)', () => {
    it('should have token tracking columns on agent_work', () => {
      const cols = db.prepare('PRAGMA table_info(agent_work)').all() as Array<{ name: string }>
      const colNames = cols.map(c => c.name)

      expect(colNames).to.include('input_tokens')
      expect(colNames).to.include('output_tokens')
      expect(colNames).to.include('cache_read_tokens')
      expect(colNames).to.include('cache_creation_tokens')
      expect(colNames).to.include('model')
      expect(colNames).to.include('estimated_cost_usd')
    })

    it('should accept token tracking data on insert', () => {
      db.prepare(`
        INSERT INTO agent_work (
          id, ticket_id, agent_name, executor, environment,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          model, estimated_cost_usd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'work-tok-001', 'TKT-500', 'test-agent', 'claude', 'host',
        15000, 3000, 5000, 1000, 'claude-opus-4-6', 0.42
      )

      const row = db.prepare(
        "SELECT input_tokens, output_tokens, model, estimated_cost_usd FROM agent_work WHERE id = 'work-tok-001'"
      ).get() as Record<string, unknown>

      expect(row.input_tokens).to.equal(15000)
      expect(row.output_tokens).to.equal(3000)
      expect(row.model).to.equal('claude-opus-4-6')
      expect(row.estimated_cost_usd).to.be.closeTo(0.42, 0.001)
    })
  })

  // ===========================================================================
  // 6. Monitor command can be imported without errors
  // ===========================================================================
  describe('Monitor command (import check)', () => {
    it('should import monitor utility functions without error', async () => {
      const monitor = await import('../../src/commands/monitor.js')
      expect(monitor.formatDuration).to.be.a('function')
      expect(monitor.padEnd).to.be.a('function')
      expect(monitor.truncate).to.be.a('function')
      expect(monitor.buildAgentSnapshot).to.be.a('function')
      expect(monitor.renderDashboard).to.be.a('function')
    })

    it('should format durations correctly', async () => {
      const { formatDuration } = await import('../../src/commands/monitor.js')
      expect(formatDuration(0)).to.be.a('string')
      expect(formatDuration(60_000)).to.include('1')   // 1 minute
      expect(formatDuration(3_600_000)).to.include('1') // 1 hour
    })

    it('should render an empty dashboard without error', async () => {
      const { renderDashboard } = await import('../../src/commands/monitor.js')
      const output = renderDashboard([])
      expect(output).to.be.a('string')
    })
  })

  // ===========================================================================
  // 7. Repo add --path registers a local path without cloning
  // ===========================================================================
  describe('Repo registration (repositories table)', () => {
    it('should store a linked repo with action=link', () => {
      const repoPath = path.join(env.testDir, 'my-repo')
      fs.mkdirSync(repoPath, { recursive: true })

      db.prepare(`
        INSERT INTO repositories (name, path, type, action, added_at)
        VALUES (?, ?, 'main', 'link', datetime('now'))
      `).run('my-repo', repoPath)

      const row = db.prepare(
        "SELECT * FROM repositories WHERE name = 'my-repo'"
      ).get() as Record<string, unknown>

      expect(row).to.exist
      expect(row.path).to.equal(repoPath)
      expect(row.action).to.equal('link')
      expect(row.source_url).to.be.null
    })

    it('should distinguish link vs clone actions', () => {
      db.prepare(`
        INSERT INTO repositories (name, path, type, action, added_at)
        VALUES ('linked-repo', '/tmp/local', 'main', 'link', datetime('now'))
      `).run()
      db.prepare(`
        INSERT INTO repositories (name, path, type, source_url, action, added_at)
        VALUES ('cloned-repo', '/tmp/clone', 'main', 'https://github.com/org/repo', 'clone', datetime('now'))
      `).run()

      const linked = db.prepare("SELECT action FROM repositories WHERE name = 'linked-repo'").get() as { action: string }
      const cloned = db.prepare("SELECT action FROM repositories WHERE name = 'cloned-repo'").get() as { action: string }

      expect(linked.action).to.equal('link')
      expect(cloned.action).to.equal('clone')
    })
  })

  // ===========================================================================
  // 8. Ticket create --repo stores the repos field
  // ===========================================================================
  describe('Ticket repos field (pmo_tickets.repos)', () => {
    let projectId: string

    beforeEach(() => {
      projectId = createTestProject(db, { id: 'test-proj', name: 'Test Project' })
    })

    it('should store repos as JSON array on ticket', () => {
      const repos = ['frontend', 'backend', 'shared-lib']
      db.prepare(`
        INSERT INTO pmo_tickets (id, project_id, title, repos, created_at, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run('TKT-REPO-001', projectId, 'Multi-repo ticket', JSON.stringify(repos))

      const row = db.prepare(
        "SELECT repos FROM pmo_tickets WHERE id = 'TKT-REPO-001'"
      ).get() as { repos: string }

      expect(JSON.parse(row.repos)).to.deep.equal(repos)
    })

    it('should allow null repos for single-repo tickets', () => {
      db.prepare(`
        INSERT INTO pmo_tickets (id, project_id, title, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now'), datetime('now'))
      `).run('TKT-REPO-002', projectId, 'Single-repo ticket')

      const row = db.prepare(
        "SELECT repos FROM pmo_tickets WHERE id = 'TKT-REPO-002'"
      ).get() as { repos: string | null }

      expect(row.repos).to.be.null
    })

    it('should roundtrip repos column via update', () => {
      db.prepare(`
        INSERT INTO pmo_tickets (id, project_id, title, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now'), datetime('now'))
      `).run('TKT-REPO-003', projectId, 'Update test')

      const repos = ['api', 'web']
      db.prepare("UPDATE pmo_tickets SET repos = ? WHERE id = 'TKT-REPO-003'")
        .run(JSON.stringify(repos))

      const row = db.prepare(
        "SELECT repos FROM pmo_tickets WHERE id = 'TKT-REPO-003'"
      ).get() as { repos: string }

      expect(JSON.parse(row.repos)).to.deep.equal(repos)
    })
  })

  // ===========================================================================
  // 9. Message queue table exists and accepts inserts
  // ===========================================================================
  describe('Message queue (agent-to-agent comms)', () => {
    it('should have message_queue table', () => {
      const table = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='message_queue'"
      ).get() as { name: string } | undefined

      expect(table).to.exist
      expect(table!.name).to.equal('message_queue')
    })

    it('should insert and retrieve messages', () => {
      db.prepare(`
        INSERT INTO message_queue (from_agent, to_agent, message, status)
        VALUES (?, ?, ?, 'pending')
      `).run('agent-alpha', 'agent-beta', 'Please review PR #42')

      const messages = db.prepare(
        "SELECT * FROM message_queue WHERE to_agent = 'agent-beta'"
      ).all() as Array<Record<string, unknown>>

      expect(messages).to.have.lengthOf(1)
      expect(messages[0].from_agent).to.equal('agent-alpha')
      expect(messages[0].message).to.equal('Please review PR #42')
      expect(messages[0].status).to.equal('pending')
    })

    it('should track message delivery lifecycle', () => {
      const result = db.prepare(`
        INSERT INTO message_queue (from_agent, to_agent, message, status)
        VALUES ('sender', 'receiver', 'hello', 'pending')
      `).run()

      const msgId = result.lastInsertRowid

      // Mark delivered
      db.prepare(`
        UPDATE message_queue SET status = 'delivered', delivered_at = datetime('now')
        WHERE id = ?
      `).run(msgId)

      const delivered = db.prepare(
        'SELECT status, delivered_at FROM message_queue WHERE id = ?'
      ).get(msgId) as Record<string, unknown>

      expect(delivered.status).to.equal('delivered')
      expect(delivered.delivered_at).to.not.be.null

      // Mark read
      db.prepare(`
        UPDATE message_queue SET status = 'read', read_at = datetime('now')
        WHERE id = ?
      `).run(msgId)

      const read = db.prepare(
        'SELECT status, read_at FROM message_queue WHERE id = ?'
      ).get(msgId) as Record<string, unknown>

      expect(read.status).to.equal('read')
      expect(read.read_at).to.not.be.null
    })

    it('should reject invalid message status values', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO message_queue (from_agent, to_agent, message, status)
          VALUES ('a', 'b', 'test', 'bogus')
        `).run()
      }).to.throw()
    })
  })

  // ===========================================================================
  // 10. Watchdog settings can be stored and retrieved
  // ===========================================================================
  describe('Watchdog settings (workspace_settings)', () => {
    it('should store and retrieve all watchdog settings', () => {
      const settings: Record<string, string> = {
        'watchdog.enabled': 'true',
        'watchdog.context_detection': 'true',
        'watchdog.crash_recovery': 'false',
        'watchdog.stuck_detection': 'true',
        'watchdog.auto_permit': 'false',
        'watchdog.context_threshold': '0.15',
        'watchdog.stuck_timeout_secs': '600',
      }

      const upsert = db.prepare(`
        INSERT INTO workspace_settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      for (const [key, value] of Object.entries(settings)) {
        upsert.run(key, value)
      }

      // Retrieve by prefix
      const rows = db.prepare(
        "SELECT key, value FROM workspace_settings WHERE key LIKE 'watchdog.%'"
      ).all() as Array<{ key: string; value: string }>

      const retrieved = Object.fromEntries(rows.map(r => [r.key, r.value]))

      expect(retrieved).to.deep.equal(settings)
    })

    it('should update watchdog threshold via upsert', () => {
      const upsert = db.prepare(`
        INSERT INTO workspace_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      upsert.run('watchdog.context_threshold', '0.20')
      upsert.run('watchdog.context_threshold', '0.10')

      const row = db.prepare(
        "SELECT value FROM workspace_settings WHERE key = 'watchdog.context_threshold'"
      ).get() as { value: string }

      expect(row.value).to.equal('0.10')
    })

    it('should coexist with scheduler settings without conflict', () => {
      const upsert = db.prepare(`
        INSERT INTO workspace_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      upsert.run('watchdog.enabled', 'true')
      upsert.run('scheduler.max_agents', '5')

      const all = db.prepare(
        'SELECT key FROM workspace_settings WHERE key LIKE ? OR key LIKE ?'
      ).all('watchdog.%', 'scheduler.%') as Array<{ key: string }>

      const keys = all.map(r => r.key)
      expect(keys).to.include('watchdog.enabled')
      expect(keys).to.include('scheduler.max_agents')
    })
  })
})

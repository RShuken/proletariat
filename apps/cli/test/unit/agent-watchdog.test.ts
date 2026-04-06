import { expect } from 'chai'
import Database from 'better-sqlite3'
import { AgentWatchdog, readWatchdogConfig, WATCHDOG_SETTINGS } from '../../src/lib/orchestrate/agent-watchdog.js'
import type { AgentWatchdogDeps } from '../../src/lib/orchestrate/agent-watchdog.js'
import { ExecutionStorage } from '../../src/lib/execution/storage.js'
import { PMO_TABLES } from '../../src/lib/pmo/schema.js'

/**
 * Unit tests for AgentWatchdog.
 *
 * Tests cover:
 * - Context exhaustion detection and /compact triggering
 * - Crash detection and session restart
 * - Stuck agent detection and poke messaging
 * - Permission prompt detection and auto-approve
 * - Watchdog config reading from workspace_settings
 * - Cooldown enforcement (no duplicate actions)
 * - Cleanup of stale tracking state
 */

// =============================================================================
// Test Helpers
// =============================================================================

function createTestDb(): Database.Database {
  const db = new Database(':memory:')

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PMO_TABLES.agent_work} (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      executor TEXT NOT NULL,
      environment TEXT DEFAULT 'host',
      display_mode TEXT DEFAULT 'terminal',
      permission_mode TEXT DEFAULT 'safe',
      cleanup_policy TEXT NOT NULL DEFAULT 'on-exit',
      status TEXT NOT NULL,
      branch TEXT,
      pid TEXT,
      container_id TEXT,
      session_id TEXT,
      host TEXT,
      log_path TEXT,
      external_source TEXT,
      external_key TEXT,
      external_id TEXT,
      external_url TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      exit_code INTEGER,
      error_message TEXT,
      last_heartbeat TEXT,
      lifecycle_state TEXT,
      retries INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      model TEXT,
      estimated_cost_usd REAL DEFAULT 0
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  return db
}

function insertExecution(db: Database.Database, overrides: Partial<{
  id: string
  ticketId: string
  agentName: string
  status: string
  sessionId: string
  environment: string
  permissionMode: string
  lifecycleState: string
}> = {}): string {
  const id = overrides.id ?? `WORK-${Math.random().toString(36).slice(2, 10).toUpperCase()}`
  db.prepare(`
    INSERT INTO ${PMO_TABLES.agent_work} (
      id, ticket_id, agent_name, executor, environment, display_mode,
      permission_mode, status, session_id, started_at, lifecycle_state
    ) VALUES (?, ?, ?, 'claude-code', ?, 'terminal', ?, ?, ?, ?, ?)
  `).run(
    id,
    overrides.ticketId ?? 'TKT-001',
    overrides.agentName ?? 'agent-alpha',
    overrides.environment ?? 'host',
    overrides.permissionMode ?? 'safe',
    overrides.status ?? 'running',
    overrides.sessionId ?? `prlt-session-${id}`,
    Date.now(),
    overrides.lifecycleState ?? 'healthy',
  )
  return id
}

/** Create fake deps that don't touch real tmux or filesystem. */
function fakeDeps(overrides: Partial<AgentWatchdogDeps> = {}): AgentWatchdogDeps {
  return {
    getHostTmuxSessionNames: () => [],
    captureTmuxPane: () => null,
    sendTmuxMessage: () => {},
    findSessionLogPath: () => null,
    parseSessionTokensSync: () => ({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, model: null, estimatedCostUsd: 0,
    }),
    restartSession: () => true,
    ...overrides,
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('AgentWatchdog', () => {
  let db: Database.Database
  let storage: ExecutionStorage

  beforeEach(() => {
    db = createTestDb()
    storage = new ExecutionStorage(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('runCycle', () => {
    it('returns zero agents checked when no running executions', async () => {
      const watchdog = new AgentWatchdog({ storage, deps: fakeDeps() })
      const result = await watchdog.runCycle()

      expect(result.agentsChecked).to.equal(0)
      expect(result.actions).to.have.length(0)
    })

    it('only checks host/sandbox executions (skips containers)', async () => {
      insertExecution(db, { id: 'WORK-HOST1', environment: 'host', status: 'running' })
      insertExecution(db, { id: 'WORK-DOCK1', environment: 'devcontainer', status: 'running' })

      const watchdog = new AgentWatchdog({
        storage,
        deps: fakeDeps({
          getHostTmuxSessionNames: () => ['prlt-session-WORK-HOST1'],
        }),
      })
      const result = await watchdog.runCycle()

      expect(result.agentsChecked).to.equal(1) // Only host exec
    })
  })

  describe('crash detection', () => {
    it('attempts restart when session is gone and autoRecover is true', async () => {
      insertExecution(db, {
        id: 'WORK-CRASH1',
        sessionId: 'prlt-session-crash1',
        status: 'running',
        permissionMode: 'safe',
      })

      let restartCalled = false
      const watchdog = new AgentWatchdog({
        storage,
        autoRecover: true,
        deps: fakeDeps({
          getHostTmuxSessionNames: () => [], // session gone
          restartSession: () => { restartCalled = true; return true },
        }),
      })
      const result = await watchdog.runCycle()

      expect(result.actions).to.have.length(1)
      expect(result.actions[0].action).to.equal('restart')
      expect(result.actions[0].detail).to.include('auto-restarted')
      expect(restartCalled).to.be.true

      // DB should be back to running
      const exec = storage.getExecution('WORK-CRASH1')
      expect(exec?.status).to.equal('running')
      expect(exec?.lifecycleState).to.equal('healthy')
    })

    it('marks session as died when autoRecover is false', async () => {
      insertExecution(db, {
        id: 'WORK-CRASH2',
        sessionId: 'prlt-session-crash2',
        status: 'running',
      })

      const watchdog = new AgentWatchdog({
        storage,
        autoRecover: false,
        deps: fakeDeps({ getHostTmuxSessionNames: () => [] }),
      })
      const result = await watchdog.runCycle()

      expect(result.actions).to.have.length(1)
      expect(result.actions[0].action).to.equal('restart')
      expect(result.actions[0].detail).to.include('auto-recover disabled')

      const exec = storage.getExecution('WORK-CRASH2')
      expect(exec?.status).to.equal('failed')
      expect(exec?.lifecycleState).to.equal('died')
    })

    it('marks session as died when restart fails', async () => {
      insertExecution(db, {
        id: 'WORK-CRASH4',
        sessionId: 'prlt-session-crash4',
        status: 'running',
      })

      const watchdog = new AgentWatchdog({
        storage,
        autoRecover: true,
        deps: fakeDeps({
          getHostTmuxSessionNames: () => [],
          restartSession: () => false, // restart fails
        }),
      })
      const result = await watchdog.runCycle()

      expect(result.actions).to.have.length(1)
      expect(result.actions[0].detail).to.include('restart failed')

      const exec = storage.getExecution('WORK-CRASH4')
      expect(exec?.status).to.equal('failed')
      expect(exec?.lifecycleState).to.equal('died')
    })

    it('does not restart the same execution twice', async () => {
      insertExecution(db, {
        id: 'WORK-CRASH3',
        sessionId: 'prlt-session-crash3',
        status: 'running',
      })

      const watchdog = new AgentWatchdog({
        storage,
        autoRecover: false,
        deps: fakeDeps({ getHostTmuxSessionNames: () => [] }),
      })

      // First cycle detects crash
      await watchdog.runCycle()

      // Reset back to running (simulate re-appearance)
      db.prepare("UPDATE agent_work SET status = 'running', lifecycle_state = 'healthy' WHERE id = 'WORK-CRASH3'").run()

      const result2 = await watchdog.runCycle()
      expect(result2.actions.filter(a => a.action === 'restart')).to.have.length(0)
    })
  })

  describe('stuck detection', () => {
    it('does not poke on first observation (needs baseline)', async () => {
      insertExecution(db, {
        id: 'WORK-STUCK1',
        sessionId: 'prlt-session-stuck1',
        status: 'running',
      })

      const watchdog = new AgentWatchdog({
        storage,
        stuckTimeoutMs: 0,
        deps: fakeDeps({
          getHostTmuxSessionNames: () => ['prlt-session-stuck1'],
          captureTmuxPane: () => 'Some output',
        }),
      })
      const result = await watchdog.runCycle()

      expect(result.actions.filter(a => a.action === 'poke')).to.have.length(0)
    })

    it('pokes agent after stuck timeout with unchanged output', async () => {
      insertExecution(db, {
        id: 'WORK-STUCK2',
        sessionId: 'prlt-session-stuck2',
        status: 'running',
      })

      let sentMessage = ''
      const watchdog = new AgentWatchdog({
        storage,
        stuckTimeoutMs: 0, // immediate
        deps: fakeDeps({
          getHostTmuxSessionNames: () => ['prlt-session-stuck2'],
          captureTmuxPane: () => 'Same output',
          sendTmuxMessage: (_sid, msg) => { sentMessage = msg },
        }),
      })

      // First cycle: baseline
      await watchdog.runCycle()
      // Second cycle: same output → poke
      const result = await watchdog.runCycle()

      const pokeActions = result.actions.filter(a => a.action === 'poke')
      expect(pokeActions).to.have.length(1)
      expect(sentMessage).to.include('still working')
    })

    it('does not poke when output changes between cycles', async () => {
      insertExecution(db, {
        id: 'WORK-ACTIVE1',
        sessionId: 'prlt-session-active1',
        status: 'running',
      })

      let callCount = 0
      const watchdog = new AgentWatchdog({
        storage,
        stuckTimeoutMs: 0,
        deps: fakeDeps({
          getHostTmuxSessionNames: () => ['prlt-session-active1'],
          captureTmuxPane: () => `Output v${++callCount}`,
        }),
      })

      await watchdog.runCycle()
      const result = await watchdog.runCycle()

      expect(result.actions.filter(a => a.action === 'poke')).to.have.length(0)
    })
  })

  describe('context exhaustion', () => {
    it('sends /compact when context usage exceeds 90% threshold', async () => {
      insertExecution(db, {
        id: 'WORK-CTX1',
        sessionId: 'prlt-session-ctx1',
        status: 'running',
      })

      let compactSent = false
      const watchdog = new AgentWatchdog({
        storage,
        contextThreshold: 0.10,
        deps: fakeDeps({
          getHostTmuxSessionNames: () => ['prlt-session-ctx1'],
          findSessionLogPath: () => '/tmp/fake.jsonl',
          parseSessionTokensSync: () => ({
            inputTokens: 185_000, outputTokens: 10_000,
            cacheReadTokens: 0, cacheCreationTokens: 0,
            model: 'claude-sonnet-4-6', estimatedCostUsd: 0.5,
          }),
          sendTmuxMessage: (_sid, msg) => { if (msg === '/compact') compactSent = true },
        }),
      })
      const result = await watchdog.runCycle()

      const compactActions = result.actions.filter(a => a.action === 'compact')
      expect(compactActions).to.have.length(1)
      expect(compactActions[0].detail).to.include('/compact')
      expect(compactSent).to.be.true
    })

    it('does not compact when context usage is within threshold', async () => {
      insertExecution(db, {
        id: 'WORK-CTX2',
        sessionId: 'prlt-session-ctx2',
        status: 'running',
      })

      const watchdog = new AgentWatchdog({
        storage,
        contextThreshold: 0.10,
        deps: fakeDeps({
          getHostTmuxSessionNames: () => ['prlt-session-ctx2'],
          findSessionLogPath: () => '/tmp/fake.jsonl',
          parseSessionTokensSync: () => ({
            inputTokens: 100_000, outputTokens: 5_000,
            cacheReadTokens: 0, cacheCreationTokens: 0,
            model: 'claude-sonnet-4-6', estimatedCostUsd: 0.3,
          }),
        }),
      })
      const result = await watchdog.runCycle()

      expect(result.actions.filter(a => a.action === 'compact')).to.have.length(0)
    })

    it('uses 1M window for opus models', async () => {
      insertExecution(db, {
        id: 'WORK-CTX-OPUS',
        sessionId: 'prlt-session-opus',
        status: 'running',
      })

      const watchdog = new AgentWatchdog({
        storage,
        contextThreshold: 0.10,
        deps: fakeDeps({
          getHostTmuxSessionNames: () => ['prlt-session-opus'],
          findSessionLogPath: () => '/tmp/fake.jsonl',
          // 170K tokens — this is only 17% of 1M, should NOT compact
          parseSessionTokensSync: () => ({
            inputTokens: 170_000, outputTokens: 10_000,
            cacheReadTokens: 0, cacheCreationTokens: 0,
            model: 'claude-opus-4-6', estimatedCostUsd: 1.0,
          }),
        }),
      })
      const result = await watchdog.runCycle()

      expect(result.actions.filter(a => a.action === 'compact')).to.have.length(0)
    })

    it('respects compact cooldown', async () => {
      insertExecution(db, {
        id: 'WORK-CTX3',
        sessionId: 'prlt-session-ctx3',
        status: 'running',
      })

      const watchdog = new AgentWatchdog({
        storage,
        contextThreshold: 0.10,
        deps: fakeDeps({
          getHostTmuxSessionNames: () => ['prlt-session-ctx3'],
          findSessionLogPath: () => '/tmp/fake.jsonl',
          parseSessionTokensSync: () => ({
            inputTokens: 185_000, outputTokens: 5_000,
            cacheReadTokens: 0, cacheCreationTokens: 0,
            model: 'claude-sonnet-4-6', estimatedCostUsd: 0.5,
          }),
        }),
      })

      const result1 = await watchdog.runCycle()
      expect(result1.actions.filter(a => a.action === 'compact')).to.have.length(1)

      // Second cycle should not compact (cooldown)
      const result2 = await watchdog.runCycle()
      expect(result2.actions.filter(a => a.action === 'compact')).to.have.length(0)
    })
  })

  describe('permission prompt detection', () => {
    it('auto-sends y when permission prompt detected in danger mode', async () => {
      insertExecution(db, {
        id: 'WORK-PERM1',
        sessionId: 'prlt-session-perm1',
        status: 'running',
        permissionMode: 'danger',
      })

      let sentY = false
      const watchdog = new AgentWatchdog({
        storage,
        deps: fakeDeps({
          getHostTmuxSessionNames: () => ['prlt-session-perm1'],
          captureTmuxPane: () => 'Do you want to proceed? (Y)es (N)o',
          sendTmuxMessage: (_sid, msg) => { if (msg === 'y') sentY = true },
        }),
      })
      const result = await watchdog.runCycle()

      const permitActions = result.actions.filter(a => a.action === 'auto_permit')
      expect(permitActions).to.have.length(1)
      expect(sentY).to.be.true
    })

    it('does not auto-permit in safe mode', async () => {
      insertExecution(db, {
        id: 'WORK-PERM2',
        sessionId: 'prlt-session-perm2',
        status: 'running',
        permissionMode: 'safe',
      })

      const watchdog = new AgentWatchdog({
        storage,
        deps: fakeDeps({
          getHostTmuxSessionNames: () => ['prlt-session-perm2'],
          captureTmuxPane: () => 'Do you want to proceed? (Y)es (N)o',
        }),
      })
      const result = await watchdog.runCycle()

      expect(result.actions.filter(a => a.action === 'auto_permit')).to.have.length(0)
    })

    it('does not trigger on normal output', async () => {
      insertExecution(db, {
        id: 'WORK-PERM3',
        sessionId: 'prlt-session-perm3',
        status: 'running',
        permissionMode: 'danger',
      })

      const watchdog = new AgentWatchdog({
        storage,
        deps: fakeDeps({
          getHostTmuxSessionNames: () => ['prlt-session-perm3'],
          captureTmuxPane: () => 'Building project... 50% complete',
        }),
      })
      const result = await watchdog.runCycle()

      expect(result.actions.filter(a => a.action === 'auto_permit')).to.have.length(0)
    })

    it('detects "Allow once" permission pattern', async () => {
      insertExecution(db, {
        id: 'WORK-PERM4',
        sessionId: 'prlt-session-perm4',
        status: 'running',
        permissionMode: 'danger',
      })

      let sentY = false
      const watchdog = new AgentWatchdog({
        storage,
        deps: fakeDeps({
          getHostTmuxSessionNames: () => ['prlt-session-perm4'],
          captureTmuxPane: () => 'Allow once  Allow always  Deny',
          sendTmuxMessage: (_sid, msg) => { if (msg === 'y') sentY = true },
        }),
      })
      const result = await watchdog.runCycle()

      expect(result.actions.filter(a => a.action === 'auto_permit')).to.have.length(1)
      expect(sentY).to.be.true
    })
  })

  describe('cleanup and reset', () => {
    it('handles empty execution list gracefully', async () => {
      const watchdog = new AgentWatchdog({ storage, deps: fakeDeps() })
      const result = await watchdog.runCycle()
      expect(result.agentsChecked).to.equal(0)
    })

    it('reset() clears all internal state', () => {
      const watchdog = new AgentWatchdog({ storage, deps: fakeDeps() })
      watchdog.reset()
      // Should not throw
    })
  })
})

describe('readWatchdogConfig', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE workspace_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
  })

  afterEach(() => {
    db.close()
  })

  it('returns defaults when no settings configured', () => {
    const config = readWatchdogConfig(db)
    expect(config.enabled).to.be.true
    expect(config.contextDetection).to.be.true
    expect(config.crashRecovery).to.be.true
    expect(config.stuckDetection).to.be.true
    expect(config.autoPermit).to.be.true
    expect(config.contextThreshold).to.equal(0.10)
    expect(config.stuckTimeoutSecs).to.equal(300)
  })

  it('reads overridden settings', () => {
    db.prepare("INSERT INTO workspace_settings (key, value) VALUES (?, ?)").run(WATCHDOG_SETTINGS.enabled, 'false')
    db.prepare("INSERT INTO workspace_settings (key, value) VALUES (?, ?)").run(WATCHDOG_SETTINGS.contextThreshold, '0.30')
    db.prepare("INSERT INTO workspace_settings (key, value) VALUES (?, ?)").run(WATCHDOG_SETTINGS.stuckTimeoutSecs, '600')

    const config = readWatchdogConfig(db)
    expect(config.enabled).to.be.false
    expect(config.contextThreshold).to.equal(0.30)
    expect(config.stuckTimeoutSecs).to.equal(600)
  })

  it('handles missing workspace_settings table gracefully', () => {
    const bareDb = new Database(':memory:')
    const config = readWatchdogConfig(bareDb)
    expect(config.enabled).to.be.true // defaults
    bareDb.close()
  })
})

describe('Migration 0025 — watchdog_settings', () => {
  it('seeds default watchdog settings', async () => {
    const { watchdogSettings } = await import('../../src/lib/database/migrations/0026_watchdog_settings.js')
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE workspace_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)

    watchdogSettings.up(db)

    const rows = db.prepare('SELECT key, value FROM workspace_settings WHERE key LIKE ?').all('watchdog.%') as Array<{ key: string; value: string }>
    expect(rows.length).to.be.greaterThanOrEqual(7)

    const enabledRow = rows.find(r => r.key === 'watchdog.enabled')
    expect(enabledRow?.value).to.equal('true')

    const thresholdRow = rows.find(r => r.key === 'watchdog.context_threshold')
    expect(thresholdRow?.value).to.equal('0.10')

    db.close()
  })

  it('does not overwrite existing settings', async () => {
    const { watchdogSettings } = await import('../../src/lib/database/migrations/0026_watchdog_settings.js')
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE workspace_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)

    db.prepare("INSERT INTO workspace_settings (key, value) VALUES (?, ?)").run('watchdog.enabled', 'false')

    watchdogSettings.up(db)

    const row = db.prepare('SELECT value FROM workspace_settings WHERE key = ?').get('watchdog.enabled') as { value: string }
    expect(row.value).to.equal('false') // preserved

    db.close()
  })

  it('skips if workspace_settings table does not exist', async () => {
    const { watchdogSettings } = await import('../../src/lib/database/migrations/0026_watchdog_settings.js')
    const db = new Database(':memory:')

    // Should not throw
    watchdogSettings.up(db)

    db.close()
  })
})

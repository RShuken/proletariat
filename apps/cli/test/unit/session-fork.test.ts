import { expect } from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { ExecutionStorage } from '../../src/lib/execution/storage.js'
import { PMO_TABLES } from '../../src/lib/pmo/schema.js'
import { createFastTestDb, type FastTestDb } from '../e2e/test-helpers.js'
import {
  findClaudeSessionLog,
  copySessionLog,
  getCurrentBranch,
  resolveSourceWorktreePath,
} from '../../src/commands/session/fork.js'

/**
 * TKT-025: Unit tests for session fork command helpers and database flow.
 */
describe('@smoke TKT-025: Session Fork', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prlt-fork-test-')))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ===========================================================================
  // findClaudeSessionLog
  // ===========================================================================

  describe('findClaudeSessionLog', () => {
    let originalHome: string

    beforeEach(() => {
      originalHome = process.env.HOME || ''
      // Override HOME to use tmpDir so we can control ~/.claude/projects/
      process.env.HOME = tmpDir
    })

    afterEach(() => {
      process.env.HOME = originalHome
    })

    it('returns null when no claude dir exists', () => {
      const result = findClaudeSessionLog('some-session', '/fake/worktree')
      expect(result).to.be.null
    })

    it('finds JSONL by worktree path in project directory', () => {
      const worktreePath = '/workspace/agents/temp/my-agent'
      const projectDirName = '-' + worktreePath.replace(/\//g, '-')
      const projectDir = path.join(tmpDir, '.claude', 'projects', projectDirName)
      fs.mkdirSync(projectDir, { recursive: true })

      // Create a JSONL file
      const jsonlPath = path.join(projectDir, 'abc123.jsonl')
      fs.writeFileSync(jsonlPath, '{"type":"assistant"}\n')

      const result = findClaudeSessionLog('some-session', worktreePath)
      expect(result).to.equal(jsonlPath)
    })

    it('returns the most recent JSONL when multiple exist', () => {
      const worktreePath = '/workspace/agents/temp/my-agent'
      const projectDirName = '-' + worktreePath.replace(/\//g, '-')
      const projectDir = path.join(tmpDir, '.claude', 'projects', projectDirName)
      fs.mkdirSync(projectDir, { recursive: true })

      // Create two JSONL files with different mtimes
      const oldFile = path.join(projectDir, 'old-session.jsonl')
      const newFile = path.join(projectDir, 'new-session.jsonl')
      fs.writeFileSync(oldFile, '{"type":"assistant"}\n')

      // Touch the new file slightly later
      const now = new Date()
      fs.writeFileSync(newFile, '{"type":"assistant"}\n')
      fs.utimesSync(oldFile, new Date(now.getTime() - 10000), new Date(now.getTime() - 10000))

      const result = findClaudeSessionLog('some-session', worktreePath)
      expect(result).to.equal(newFile)
    })

    it('returns null when project dir has no JSONL files', () => {
      const worktreePath = '/workspace/agents/temp/my-agent'
      const projectDirName = '-' + worktreePath.replace(/\//g, '-')
      const projectDir = path.join(tmpDir, '.claude', 'projects', projectDirName)
      fs.mkdirSync(projectDir, { recursive: true })

      // Create a non-JSONL file
      fs.writeFileSync(path.join(projectDir, 'readme.txt'), 'not a jsonl')

      const result = findClaudeSessionLog('some-session', worktreePath)
      expect(result).to.be.null
    })
  })

  // ===========================================================================
  // copySessionLog
  // ===========================================================================

  describe('copySessionLog', () => {
    let originalHome: string

    beforeEach(() => {
      originalHome = process.env.HOME || ''
      process.env.HOME = tmpDir
    })

    afterEach(() => {
      process.env.HOME = originalHome
    })

    it('copies JSONL to new worktree project dir', () => {
      // Create source JSONL
      const sourceDir = path.join(tmpDir, 'source')
      fs.mkdirSync(sourceDir, { recursive: true })
      const sourcePath = path.join(sourceDir, 'session-abc.jsonl')
      fs.writeFileSync(sourcePath, '{"type":"assistant","message":{"model":"claude"}}\n')

      const newWorktreePath = '/workspace/agents/temp/fork-agent'
      const result = copySessionLog(sourcePath, newWorktreePath)

      // Verify the file was copied
      expect(fs.existsSync(result)).to.be.true

      // Verify contents match
      const sourceContent = fs.readFileSync(sourcePath, 'utf-8')
      const destContent = fs.readFileSync(result, 'utf-8')
      expect(destContent).to.equal(sourceContent)

      // Verify filename preserved
      expect(path.basename(result)).to.equal('session-abc.jsonl')

      // Verify correct directory structure
      const expectedDirName = '-' + newWorktreePath.replace(/\//g, '-')
      expect(result).to.include(expectedDirName)
    })

    it('preserves original file (copy, not move)', () => {
      const sourceDir = path.join(tmpDir, 'source')
      fs.mkdirSync(sourceDir, { recursive: true })
      const sourcePath = path.join(sourceDir, 'session-xyz.jsonl')
      fs.writeFileSync(sourcePath, '{"type":"tool_use"}\n')

      copySessionLog(sourcePath, '/workspace/agents/temp/fork')

      // Source file should still exist
      expect(fs.existsSync(sourcePath)).to.be.true
    })
  })

  // ===========================================================================
  // resolveSourceWorktreePath
  // ===========================================================================

  describe('resolveSourceWorktreePath', () => {
    it('finds worktree in standard agent temp directory', () => {
      const workspacePath = tmpDir
      const agentDir = path.join(workspacePath, 'agents', 'temp', 'my-agent')
      fs.mkdirSync(agentDir, { recursive: true })

      const exec = {
        agentName: 'my-agent',
        branch: 'feat/test',
      } as any

      const result = resolveSourceWorktreePath(exec, workspacePath)
      expect(result).to.equal(agentDir)
    })

    it('returns null when agent directory does not exist', () => {
      const exec = {
        agentName: 'nonexistent-agent',
        branch: undefined,
      } as any

      const result = resolveSourceWorktreePath(exec, tmpDir)
      expect(result).to.be.null
    })
  })

  // ===========================================================================
  // Database integration: fork creates execution record
  // ===========================================================================

  describe('fork execution record', () => {
    let fastDb: FastTestDb
    let db: Database.Database
    let storage: ExecutionStorage

    before(() => {
      fastDb = createFastTestDb((db) => {
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
            error_message TEXT
          )
        `)
      })
      db = fastDb.db
    })

    beforeEach(() => {
      fastDb.savepoint()
      storage = new ExecutionStorage(db)
    })

    afterEach(() => {
      fastDb.rollback()
    })

    after(() => {
      fastDb.close()
    })

    it('creates forked execution linked to same ticket as source', () => {
      // Create source execution
      const source = storage.createExecution({
        ticketId: 'TKT-100',
        agentName: 'original-agent',
        executor: 'claude-code',
        environment: 'host',
        displayMode: 'terminal',
        permissionMode: 'danger',
        branch: 'feat/original',
        sessionId: 'user--TKT-100-work-original-agent',
      })
      storage.updateStatus(source.id, 'running')

      // Simulate fork: create new execution for same ticket
      const forked = storage.createExecution({
        ticketId: source.ticketId,
        agentName: 'original-agent-fork',
        executor: source.executor,
        environment: source.environment,
        displayMode: source.displayMode,
        permissionMode: source.permissionMode,
        cleanupPolicy: source.cleanupPolicy,
        branch: 'feat/original-fork-1234',
        sessionId: 'user--TKT-100-work-original-agent-fork',
      })
      storage.updateStatus(forked.id, 'running')

      // Verify both executions exist for the same ticket
      const allExecs = storage.listExecutions({ ticketId: 'TKT-100' })
      expect(allExecs).to.have.length(2)

      // Verify forked execution properties
      const forkedExec = storage.getExecution(forked.id)!
      expect(forkedExec.ticketId).to.equal('TKT-100')
      expect(forkedExec.agentName).to.equal('original-agent-fork')
      expect(forkedExec.branch).to.equal('feat/original-fork-1234')
      expect(forkedExec.sessionId).to.equal('user--TKT-100-work-original-agent-fork')
      expect(forkedExec.status).to.equal('running')
      expect(forkedExec.executor).to.equal('claude-code')
      expect(forkedExec.permissionMode).to.equal('danger')
    })

    it('source execution remains running after fork', () => {
      const source = storage.createExecution({
        ticketId: 'TKT-200',
        agentName: 'src-agent',
        executor: 'claude-code',
        environment: 'host',
        displayMode: 'terminal',
        permissionMode: 'safe',
        sessionId: 'user--TKT-200-work-src-agent',
      })
      storage.updateStatus(source.id, 'running')

      // Fork
      storage.createExecution({
        ticketId: 'TKT-200',
        agentName: 'src-agent-fork',
        executor: 'claude-code',
        environment: 'host',
        displayMode: 'terminal',
        permissionMode: 'safe',
        branch: 'feat/fork',
        sessionId: 'user--TKT-200-work-src-agent-fork',
      })

      // Source should still be running
      const sourceAfter = storage.getExecution(source.id)!
      expect(sourceAfter.status).to.equal('running')
    })

    it('forked agent shows up in getAgentRunningExecutions', () => {
      storage.createExecution({
        ticketId: 'TKT-300',
        agentName: 'test-fork',
        executor: 'claude-code',
        environment: 'host',
        displayMode: 'terminal',
        permissionMode: 'safe',
        branch: 'feat/fork-branch',
        sessionId: 'user--TKT-300-work-test-fork',
      })

      const running = storage.getAgentRunningExecutions('test-fork')
      // status is 'starting' since we didn't call updateStatus to 'running'
      expect(running).to.have.length(1)
      expect(running[0].agentName).to.equal('test-fork')
    })

    it('fork name conflict detected via getAgentRunningExecutions', () => {
      // First fork
      const exec1 = storage.createExecution({
        ticketId: 'TKT-400',
        agentName: 'conflict-fork',
        executor: 'claude-code',
        environment: 'host',
        displayMode: 'terminal',
        permissionMode: 'safe',
      })
      storage.updateStatus(exec1.id, 'running')

      // Attempting to check if name is in use
      const existing = storage.getAgentRunningExecutions('conflict-fork')
      expect(existing).to.have.length(1)
      // Command would refuse to fork with this name
    })
  })

  // ===========================================================================
  // getCurrentBranch
  // ===========================================================================

  describe('getCurrentBranch', () => {
    it('returns branch name for a git repo', () => {
      // Use the actual repo we're in
      const branch = getCurrentBranch(process.cwd())
      expect(branch).to.be.a('string')
      expect(branch.length).to.be.greaterThan(0)
    })

    it('returns "unknown" for non-git directory', () => {
      const branch = getCurrentBranch(tmpDir)
      expect(branch).to.equal('unknown')
    })
  })
})

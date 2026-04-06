/**
 * Agent Watchdog
 *
 * Self-healing monitor for running agent sessions. Detects and recovers from:
 *
 * 1. Context exhaustion: Parses Claude Code JSONL logs to check token usage.
 *    If context usage exceeds 80% of the model's window, sends /compact to
 *    the tmux session to trigger context compaction.
 *
 * 2. Crash detection: If a tmux session dies unexpectedly (no longer in tmux
 *    list-sessions), auto-restarts the agent with the same ticket and prompt.
 *
 * 3. Stuck detection: Captures tmux pane output periodically. If no new output
 *    appears for 5+ minutes, sends a poke message asking the agent to continue.
 *
 * 4. Permission prompt detection: If the agent is waiting for a permission
 *    prompt and the execution is in danger mode (YOLO), auto-sends 'y'.
 *
 * Runs as a periodic check within the orchestrate daemon loop.
 */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ExecutionStorage } from '../execution/storage.js'
import type { AgentWork } from '../execution/types.js'
import {
  captureTmuxPane,
  sendTmuxMessage,
  getHostTmuxSessionNames,
  getHostTmuxServerStatus,
} from '../execution/session-utils.js'
import {
  findSessionLogPath,
  parseSessionTokensSync,
} from '../execution/token-parser.js'

// =============================================================================
// Constants
// =============================================================================

/** Context window sizes by model prefix (tokens). */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-6': 1_000_000,
  'claude-opus-4-5': 1_000_000,
  'claude-sonnet-4-6': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,
}

/** Default context window if model not recognized. */
const DEFAULT_CONTEXT_WINDOW = 200_000

/** Threshold: trigger compact when remaining context < this fraction. */
const CONTEXT_COMPACT_THRESHOLD = 0.20

/** Minimum interval between compact commands for the same session (ms). */
const COMPACT_COOLDOWN_MS = 5 * 60 * 1000

/** Stuck detection: no new output for this many ms triggers a poke. */
const STUCK_TIMEOUT_MS = 5 * 60 * 1000

/** Minimum interval between pokes for the same session (ms). */
const POKE_COOLDOWN_MS = 5 * 60 * 1000

/** Number of tmux pane lines to capture for comparison. */
const PANE_CAPTURE_LINES = 50

/** Patterns that indicate a permission prompt in Claude Code output. */
const PERMISSION_PATTERNS = [
  /Do you want to proceed\?/i,
  /Allow .* to run/i,
  /\(Y\)es.*\(N\)o/i,
  /Press Enter to allow/i,
  /Allow once|Allow always|Deny/i,
  /Do you trust/i,
]

// =============================================================================
// Types
// =============================================================================

/** Minimal DB interface for reading watchdog config (compatible with better-sqlite3). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WatchdogConfigDb = { prepare: (sql: string) => { get: (...args: any[]) => any } }

/**
 * Injectable dependencies for testing.
 * When not provided, real implementations are used.
 */
export interface AgentWatchdogDeps {
  getHostTmuxSessionNames?: () => string[]
  captureTmuxPane?: (sessionId: string, lines: number, containerId?: string) => string | null
  sendTmuxMessage?: (sessionId: string, message: string, containerId?: string) => void
  findSessionLogPath?: (sessionId: string, cwd?: string) => string | null
  parseSessionTokensSync?: (logPath: string) => { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; model: string | null; estimatedCostUsd: number }
  restartSession?: (sessionName: string, claudeCmd: string) => boolean
}

export interface AgentWatchdogOptions {
  /** Execution storage for DB operations */
  storage: ExecutionStorage
  /** Logger function */
  log?: (msg: string) => void
  /** Whether auto-recovery is enabled (default: true) */
  autoRecover?: boolean
  /** Stuck timeout in ms (default: 5 min) */
  stuckTimeoutMs?: number
  /** Context compact threshold 0-1 (default: 0.20) */
  contextThreshold?: number
  /** Injectable dependencies for testing */
  deps?: AgentWatchdogDeps
}

export interface WatchdogAction {
  timestamp: Date
  executionId: string
  agentName: string
  ticketId: string
  action: 'compact' | 'restart' | 'poke' | 'auto_permit'
  detail: string
}

export interface AgentWatchdogCycleResult {
  /** Number of running agents checked */
  agentsChecked: number
  /** Actions taken this cycle */
  actions: WatchdogAction[]
}

// =============================================================================
// Agent Watchdog
// =============================================================================

/**
 * Default implementation: restart a tmux session with the given command.
 */
function defaultRestartSession(sessionName: string, claudeCmd: string): boolean {
  try {
    execFileSync('tmux', [
      'new-session', '-d',
      '-s', sessionName,
      '-n', sessionName,
      claudeCmd,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    })
    return true
  } catch {
    return false
  }
}

export class AgentWatchdog {
  private storage: ExecutionStorage
  private log: (msg: string) => void
  private autoRecover: boolean
  private stuckTimeoutMs: number
  private contextThreshold: number
  private deps: Required<AgentWatchdogDeps>

  /**
   * Last captured pane output hash per execution ID.
   * Used for stuck detection — if hash doesn't change, agent is stuck.
   */
  private lastPaneHash = new Map<string, { hash: string; timestamp: number }>()

  /** Tracks when we last sent /compact per execution ID. */
  private lastCompactTime = new Map<string, number>()

  /** Tracks when we last sent a poke per execution ID. */
  private lastPokeTime = new Map<string, number>()

  /** Tracks executions we've already restarted to avoid loops. */
  private restartedExecutions = new Set<string>()

  /** Dedicated log file path */
  private logFilePath: string | null = null

  constructor(options: AgentWatchdogOptions) {
    this.storage = options.storage
    this.log = options.log ?? (() => {})
    this.autoRecover = options.autoRecover ?? true
    this.stuckTimeoutMs = options.stuckTimeoutMs ?? STUCK_TIMEOUT_MS
    this.contextThreshold = options.contextThreshold ?? CONTEXT_COMPACT_THRESHOLD

    // Wire up dependencies (real or injected for testing)
    const d = options.deps ?? {}
    this.deps = {
      getHostTmuxSessionNames: d.getHostTmuxSessionNames ?? getHostTmuxSessionNames,
      captureTmuxPane: d.captureTmuxPane ?? captureTmuxPane,
      sendTmuxMessage: d.sendTmuxMessage ?? sendTmuxMessage,
      findSessionLogPath: d.findSessionLogPath ?? findSessionLogPath,
      parseSessionTokensSync: d.parseSessionTokensSync ?? parseSessionTokensSync,
      restartSession: d.restartSession ?? defaultRestartSession,
    }
  }

  /**
   * Set the dedicated log file path for watchdog actions.
   */
  setLogFile(logPath: string): void {
    this.logFilePath = logPath
    // Ensure the directory exists
    const dir = path.dirname(logPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  /**
   * Run a single watchdog check cycle.
   * Checks all running agent sessions for problems and takes corrective action.
   */
  async runCycle(): Promise<AgentWatchdogCycleResult> {
    const result: AgentWatchdogCycleResult = {
      agentsChecked: 0,
      actions: [],
    }

    // Get all running/starting executions
    const runningExecs = this.storage.listExecutions({ status: 'running' })
    const startingExecs = this.storage.listExecutions({ status: 'starting' })
    const activeExecs = [...runningExecs, ...startingExecs]

    // Only check host-based sessions (container watchdog is separate)
    const hostExecs = activeExecs.filter(
      e => e.environment === 'host' || e.environment === 'sandbox',
    )

    result.agentsChecked = hostExecs.length

    if (hostExecs.length === 0) {
      this.cleanupStaleTracking(new Set())
      return result
    }

    // Get current tmux sessions for crash detection
    const tmuxSessions = new Set(this.deps.getHostTmuxSessionNames())
    const activeIds = new Set(hostExecs.map(e => e.id))

    for (const exec of hostExecs) {
      // 1. Crash detection — session no longer exists
      if (exec.sessionId && !tmuxSessions.has(exec.sessionId)) {
        const action = await this.handleCrashedSession(exec)
        if (action) result.actions.push(action)
        continue
      }

      // Skip remaining checks if no session ID
      if (!exec.sessionId) continue

      // 2. Context exhaustion detection
      const compactAction = this.checkContextExhaustion(exec)
      if (compactAction) result.actions.push(compactAction)

      // 3. Permission prompt detection (only for danger mode)
      const permitAction = this.checkPermissionPrompt(exec)
      if (permitAction) result.actions.push(permitAction)

      // 4. Stuck detection
      const stuckAction = this.checkStuckAgent(exec)
      if (stuckAction) result.actions.push(stuckAction)
    }

    // Clean up tracking for executions that are no longer active
    this.cleanupStaleTracking(activeIds)

    return result
  }

  // ===========================================================================
  // Context Exhaustion Detection
  // ===========================================================================

  /**
   * Check if an agent's context window is nearly exhausted.
   * If usage exceeds (1 - threshold) of the model's context window,
   * sends /compact to the tmux session.
   */
  private checkContextExhaustion(exec: AgentWork): WatchdogAction | null {
    // Cooldown check
    const lastCompact = this.lastCompactTime.get(exec.id)
    if (lastCompact && Date.now() - lastCompact < COMPACT_COOLDOWN_MS) {
      return null
    }

    // Find and parse the JSONL log
    const logPath = this.deps.findSessionLogPath(exec.sessionId!, exec.logPath ? path.dirname(exec.logPath) : undefined)
    if (!logPath) return null

    const tokens = this.deps.parseSessionTokensSync(logPath)
    const totalInputTokens = tokens.inputTokens + tokens.cacheReadTokens

    // Determine context window for this model
    const contextWindow = this.getContextWindow(tokens.model)
    const usageRatio = totalInputTokens / contextWindow
    const remainingRatio = 1 - usageRatio

    if (remainingRatio < this.contextThreshold) {
      // Send /compact command
      try {
        this.deps.sendTmuxMessage(exec.sessionId!, '/compact', undefined)
        this.lastCompactTime.set(exec.id, Date.now())

        const detail = `Context ${Math.round(usageRatio * 100)}% used (${totalInputTokens}/${contextWindow} tokens) — sent /compact`
        this.logAction('compact', exec, detail)

        return {
          timestamp: new Date(),
          executionId: exec.id,
          agentName: exec.agentName,
          ticketId: exec.ticketId,
          action: 'compact',
          detail,
        }
      } catch (error) {
        this.log(`[agent-watchdog] Failed to send /compact to ${exec.agentName}: ${error instanceof Error ? error.message : error}`)
      }
    }

    return null
  }

  /**
   * Get context window size for a model.
   */
  private getContextWindow(model: string | null): number {
    if (!model) return DEFAULT_CONTEXT_WINDOW

    for (const [prefix, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
      if (model.startsWith(prefix) || model.includes(prefix)) return size
    }

    // Infer from model name
    if (model.includes('opus')) return 1_000_000
    if (model.includes('sonnet')) return 200_000
    if (model.includes('haiku')) return 200_000

    return DEFAULT_CONTEXT_WINDOW
  }

  // ===========================================================================
  // Crash Detection & Recovery
  // ===========================================================================

  /**
   * Handle a crashed agent session (tmux session no longer exists).
   * Attempts to restart with the same ticket and prompt.
   */
  private async handleCrashedSession(exec: AgentWork): Promise<WatchdogAction | null> {
    // Already handled this execution — don't loop
    if (this.restartedExecutions.has(exec.id)) return null
    this.restartedExecutions.add(exec.id)

    if (!this.autoRecover) {
      // Just mark as died, don't restart
      this.storage.updateStatus(exec.id, 'failed', undefined, 'tmux session lost — watchdog detected crash')
      this.storage.updateLifecycleState(exec.id, 'died')

      const detail = `Session ${exec.sessionId} lost — marked as died (auto-recover disabled)`
      this.logAction('restart', exec, detail)

      return {
        timestamp: new Date(),
        executionId: exec.id,
        agentName: exec.agentName,
        ticketId: exec.ticketId,
        action: 'restart',
        detail,
      }
    }

    // Attempt to restart the session
    try {
      const sessionName = exec.sessionId!

      // Build claude command for restart
      let claudeCmd = 'claude --resume'
      if (exec.permissionMode === 'danger') {
        claudeCmd += ' --dangerously-skip-permissions'
      }

      // Create new tmux session with the same name
      const restarted = this.deps.restartSession(sessionName, claudeCmd)
      if (!restarted) {
        throw new Error('restartSession returned false')
      }

      // Update execution back to running
      this.storage.updateStatus(exec.id, 'running')
      this.storage.updateLifecycleState(exec.id, 'healthy')
      this.storage.updateHeartbeat(exec.id)

      const detail = `Session ${sessionName} crashed — auto-restarted with --resume`
      this.logAction('restart', exec, detail)
      this.log(`[agent-watchdog] Restarted ${exec.agentName} (${exec.ticketId})`)

      return {
        timestamp: new Date(),
        executionId: exec.id,
        agentName: exec.agentName,
        ticketId: exec.ticketId,
        action: 'restart',
        detail,
      }
    } catch (error) {
      // Restart failed — mark as died
      this.storage.updateStatus(exec.id, 'failed', undefined,
        `tmux session lost — watchdog restart failed: ${error instanceof Error ? error.message : error}`)
      this.storage.updateLifecycleState(exec.id, 'died')

      const detail = `Session ${exec.sessionId} crashed — restart failed: ${error instanceof Error ? error.message : error}`
      this.logAction('restart', exec, detail)

      return {
        timestamp: new Date(),
        executionId: exec.id,
        agentName: exec.agentName,
        ticketId: exec.ticketId,
        action: 'restart',
        detail,
      }
    }
  }

  // ===========================================================================
  // Stuck Detection
  // ===========================================================================

  /**
   * Check if an agent appears stuck (no new output for stuckTimeoutMs).
   * Captures tmux pane output and compares hash with previous capture.
   */
  private checkStuckAgent(exec: AgentWork): WatchdogAction | null {
    // Cooldown check
    const lastPoke = this.lastPokeTime.get(exec.id)
    if (lastPoke && Date.now() - lastPoke < POKE_COOLDOWN_MS) {
      return null
    }

    const paneContent = this.deps.captureTmuxPane(exec.sessionId!, PANE_CAPTURE_LINES)
    if (!paneContent) return null

    const hash = simpleHash(paneContent)
    const prev = this.lastPaneHash.get(exec.id)

    if (!prev) {
      // First observation — record baseline
      this.lastPaneHash.set(exec.id, { hash, timestamp: Date.now() })
      return null
    }

    if (hash !== prev.hash) {
      // Output changed — agent is alive, update baseline
      this.lastPaneHash.set(exec.id, { hash, timestamp: Date.now() })
      return null
    }

    // Output hasn't changed — check if stuck timeout exceeded
    const staleMs = Date.now() - prev.timestamp
    if (staleMs < this.stuckTimeoutMs) {
      return null
    }

    // Agent appears stuck — send a poke
    try {
      this.deps.sendTmuxMessage(
        exec.sessionId!,
        'Are you still working? If you are stuck, please describe the issue and continue.',
        undefined,
      )
      this.lastPokeTime.set(exec.id, Date.now())

      // Reset the pane hash so we don't re-poke immediately
      this.lastPaneHash.set(exec.id, { hash, timestamp: Date.now() })

      const detail = `No new output for ${Math.round(staleMs / 1000)}s — sent poke message`
      this.logAction('poke', exec, detail)

      return {
        timestamp: new Date(),
        executionId: exec.id,
        agentName: exec.agentName,
        ticketId: exec.ticketId,
        action: 'poke',
        detail,
      }
    } catch (error) {
      this.log(`[agent-watchdog] Failed to poke ${exec.agentName}: ${error instanceof Error ? error.message : error}`)
    }

    return null
  }

  // ===========================================================================
  // Permission Prompt Detection
  // ===========================================================================

  /**
   * Check if an agent is waiting at a permission prompt.
   * Only acts if the execution is in danger mode (YOLO) — auto-sends 'y'.
   */
  private checkPermissionPrompt(exec: AgentWork): WatchdogAction | null {
    // Only auto-permit in danger mode
    if (exec.permissionMode !== 'danger') return null

    const paneContent = this.deps.captureTmuxPane(exec.sessionId!, 20)
    if (!paneContent) return null

    const isPermissionPrompt = PERMISSION_PATTERNS.some(pattern => pattern.test(paneContent))
    if (!isPermissionPrompt) return null

    // Auto-send 'y' to approve the permission
    try {
      this.deps.sendTmuxMessage(exec.sessionId!, 'y', undefined)

      const detail = 'Permission prompt detected in danger mode — auto-sent y'
      this.logAction('auto_permit', exec, detail)

      return {
        timestamp: new Date(),
        executionId: exec.id,
        agentName: exec.agentName,
        ticketId: exec.ticketId,
        action: 'auto_permit',
        detail,
      }
    } catch (error) {
      this.log(`[agent-watchdog] Failed to auto-permit ${exec.agentName}: ${error instanceof Error ? error.message : error}`)
    }

    return null
  }

  // ===========================================================================
  // Internal Helpers
  // ===========================================================================

  /**
   * Log a watchdog action to the dedicated log file.
   */
  private logAction(action: string, exec: AgentWork, detail: string): void {
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      executionId: exec.id,
      agentName: exec.agentName,
      ticketId: exec.ticketId,
      detail,
    }

    this.log(`[agent-watchdog] ${action}: ${exec.agentName} (${exec.ticketId}) — ${detail}`)

    if (this.logFilePath) {
      try {
        fs.appendFileSync(this.logFilePath, JSON.stringify(entry) + '\n')
      } catch {
        // Best effort — log file may not be writable
      }
    }
  }

  /**
   * Clean up tracking state for executions that are no longer active.
   */
  private cleanupStaleTracking(activeIds: Set<string>): void {
    for (const id of this.lastPaneHash.keys()) {
      if (!activeIds.has(id)) this.lastPaneHash.delete(id)
    }
    for (const id of this.lastCompactTime.keys()) {
      if (!activeIds.has(id)) this.lastCompactTime.delete(id)
    }
    for (const id of this.lastPokeTime.keys()) {
      if (!activeIds.has(id)) this.lastPokeTime.delete(id)
    }
    for (const id of this.restartedExecutions) {
      if (!activeIds.has(id)) this.restartedExecutions.delete(id)
    }
  }

  /**
   * Reset internal state. Useful for testing.
   */
  reset(): void {
    this.lastPaneHash.clear()
    this.lastCompactTime.clear()
    this.lastPokeTime.clear()
    this.restartedExecutions.clear()
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Simple string hash for comparing pane content.
 * Not cryptographic — just for change detection.
 */
function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return hash.toString(36)
}

// =============================================================================
// Watchdog Settings
// =============================================================================

/** Settings keys for workspace_settings table. */
export const WATCHDOG_SETTINGS = {
  /** Enable/disable the agent watchdog (default: true) */
  enabled: 'watchdog.enabled',
  /** Enable context exhaustion detection (default: true) */
  contextDetection: 'watchdog.context_detection',
  /** Enable crash recovery (default: true) */
  crashRecovery: 'watchdog.crash_recovery',
  /** Enable stuck detection (default: true) */
  stuckDetection: 'watchdog.stuck_detection',
  /** Enable permission prompt auto-approve (default: true) */
  autoPermit: 'watchdog.auto_permit',
  /** Context remaining threshold (default: 0.20) */
  contextThreshold: 'watchdog.context_threshold',
  /** Stuck timeout in seconds (default: 300) */
  stuckTimeoutSecs: 'watchdog.stuck_timeout_secs',
} as const

/**
 * Read watchdog configuration from workspace_settings.
 * Accepts any object with a prepare() method (better-sqlite3 Database or DatabaseDriver).
 */
export function readWatchdogConfig(db: WatchdogConfigDb): {
  enabled: boolean
  contextDetection: boolean
  crashRecovery: boolean
  stuckDetection: boolean
  autoPermit: boolean
  contextThreshold: number
  stuckTimeoutSecs: number
} {
  const getSetting = (key: string): string | null => {
    try {
      const row = db.prepare('SELECT value FROM workspace_settings WHERE key = ?').get(key) as { value: string } | undefined
      return row?.value ?? null
    } catch {
      return null
    }
  }

  return {
    enabled: getSetting(WATCHDOG_SETTINGS.enabled) !== 'false',
    contextDetection: getSetting(WATCHDOG_SETTINGS.contextDetection) !== 'false',
    crashRecovery: getSetting(WATCHDOG_SETTINGS.crashRecovery) !== 'false',
    stuckDetection: getSetting(WATCHDOG_SETTINGS.stuckDetection) !== 'false',
    autoPermit: getSetting(WATCHDOG_SETTINGS.autoPermit) !== 'false',
    contextThreshold: parseFloat(getSetting(WATCHDOG_SETTINGS.contextThreshold) ?? '0.20'),
    stuckTimeoutSecs: parseInt(getSetting(WATCHDOG_SETTINGS.stuckTimeoutSecs) ?? '300', 10),
  }
}

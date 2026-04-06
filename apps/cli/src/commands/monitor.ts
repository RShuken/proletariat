/**
 * prlt monitor — terminal dashboard for agent sessions
 *
 * Displays a refreshing TUI showing:
 * - Running tmux sessions with agent names and ticket IDs
 * - Last 3 lines of output from each session
 * - Git status summary per agent (branch, uncommitted changes)
 * - Uptime per session
 *
 * Refreshes every 5 seconds. Press Ctrl-C to exit.
 */

import { Flags } from '@oclif/core'
import { execSync } from 'node:child_process'
import { PromptCommand } from '../lib/prompt-command.js'
import { machineOutputFlags } from '../lib/pmo/index.js'
import {
  shouldOutputJson,
  outputSuccessAsJson,
  createMetadata,
} from '../lib/prompt-json.js'
import { styles } from '../lib/styles.js'
import { SessionStore } from '../lib/session-store.js'
import {
  isSessionVisibleToCurrentUser,
  captureTmuxPane,
  parseSessionName,
} from '../lib/execution/session-utils.js'
import { getContextUsage } from '../lib/execution/context-monitor.js'
import type { ContextLevel } from '../lib/execution/context-monitor.js'

// =============================================================================
// Helpers (exported for testing)
// =============================================================================

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

export function padEnd(str: string, len: number): string {
  return str.length >= len ? str.substring(0, len) : str + ' '.repeat(len - str.length)
}

export function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.substring(0, max - 3) + '...'
}

export interface GitStatus {
  branch: string
  uncommitted: number
}

/**
 * Get git branch and uncommitted changes count for a working directory.
 * Uses execSync with hardcoded git commands (no user input).
 */
export function getGitStatus(workdir: string): GitStatus | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
      cwd: workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim()

    const statusOutput = execSync('git status --porcelain', {
      encoding: 'utf-8',
      cwd: workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim()

    const uncommitted = statusOutput ? statusOutput.split('\n').length : 0
    return { branch, uncommitted }
  } catch {
    return null
  }
}

export interface AgentSnapshot {
  agentName: string
  ticketId: string | undefined
  runner: string
  task: string
  environment: string
  status: string
  uptime: string
  uptimeMs: number
  lastOutput: string[]
  gitStatus: GitStatus | null
  sessionName: string
  workdir: string
  contextPercent: number | null
  contextLevel: ContextLevel | null
}

export function buildAgentSnapshot(
  session: { agentName: string; runner: string; task: string; workdir: string; sessionName: string; environment: string; status: string; startedAt: Date },
): AgentSnapshot {
  const parsed = parseSessionName(session.sessionName)
  const uptimeMs = Date.now() - session.startedAt.getTime()

  // Capture last 3 lines from tmux pane
  const paneOutput = captureTmuxPane(session.sessionName, 3)
  const lastOutput = paneOutput
    ? paneOutput.split('\n').filter(line => line.trim()).slice(-3)
    : []

  // Get git status for the workdir
  const gitStatus = getGitStatus(session.workdir)

  // Get context usage from JSONL log
  let contextPercent: number | null = null
  let contextLevel: ContextLevel | null = null
  try {
    const ctxUsage = getContextUsage(session.sessionName, session.workdir)
    if (ctxUsage) {
      contextPercent = ctxUsage.usagePercent
      contextLevel = ctxUsage.level
    }
  } catch {
    // Context usage unavailable
  }

  return {
    agentName: session.agentName,
    ticketId: parsed?.ticketId,
    runner: session.runner,
    task: session.task,
    environment: session.environment,
    status: session.status,
    uptime: formatDuration(uptimeMs),
    uptimeMs,
    lastOutput,
    gitStatus,
    sessionName: session.sessionName,
    workdir: session.workdir,
    contextPercent,
    contextLevel,
  }
}

// =============================================================================
// Rendering (exported for testing)
// =============================================================================

export function renderDashboard(snapshots: AgentSnapshot[]): string {
  const lines: string[] = []
  const now = new Date()
  const timestamp = now.toLocaleTimeString()
  const width = Math.min(process.stdout.columns || 120, 120)
  const separator = '═'.repeat(width)
  const thinSep = '─'.repeat(width)

  lines.push('')
  lines.push(styles.title('  PRLT MONITOR') + styles.muted(`  ${timestamp}  (refreshes every 5s, Ctrl-C to exit)`))
  lines.push(separator)

  if (snapshots.length === 0) {
    lines.push('')
    lines.push(styles.muted('  No running agents.'))
    lines.push(styles.muted('  Start one with: prlt run "your task"'))
    lines.push('')
    lines.push(separator)
    return lines.join('\n')
  }

  // Summary bar
  const total = snapshots.length
  lines.push(styles.muted(`  ${total} agent${total === 1 ? '' : 's'} running`))
  lines.push(thinSep)

  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i]

    // Agent header line
    const ticketLabel = snap.ticketId ? styles.info(snap.ticketId) + ' ' : ''
    const statusColor = snap.status === 'running' ? styles.success : styles.warning
    const gitLabel = snap.gitStatus
      ? styles.muted(' on ') + styles.emphasis(truncate(snap.gitStatus.branch, 30)) +
        (snap.gitStatus.uncommitted > 0
          ? styles.warning(` [${snap.gitStatus.uncommitted} uncommitted]`)
          : styles.success(' [clean]'))
      : ''

    // Context usage label
    const ctxLabel = snap.contextPercent !== null
      ? styles.muted('  ctx: ') + (
          snap.contextLevel === 'critical' ? styles.error(`${snap.contextPercent}%`)
          : snap.contextLevel === 'warning' ? styles.warning(`${snap.contextPercent}%`)
          : styles.success(`${snap.contextPercent}%`)
        )
      : ''

    lines.push(
      '  ' + ticketLabel +
      styles.emphasis(snap.agentName) +
      styles.muted(' (' + snap.runner + ')') +
      '  ' + statusColor(snap.status) +
      styles.muted('  uptime: ') + snap.uptime +
      ctxLabel +
      gitLabel
    )

    // Task
    lines.push(styles.muted('  task: ') + truncate(snap.task, width - 10))

    // Last output
    if (snap.lastOutput.length > 0) {
      lines.push(styles.muted('  output:'))
      for (const line of snap.lastOutput) {
        lines.push(styles.muted('    │ ') + truncate(line, width - 8))
      }
    } else {
      lines.push(styles.muted('  output: (no recent output)'))
    }

    if (i < snapshots.length - 1) {
      lines.push(thinSep)
    }
  }

  lines.push(separator)
  lines.push(styles.muted('  prlt peek <agent>  View full output   prlt stop <agent>  Stop agent'))
  lines.push('')

  return lines.join('\n')
}

// =============================================================================
// Command
// =============================================================================

export default class Monitor extends PromptCommand {
  static description = 'Terminal dashboard showing running agents with live output, git status, and uptime'

  static examples = [
    '<%= config.bin %> monitor',
    '<%= config.bin %> monitor --interval 10',
    '<%= config.bin %> monitor --once',
    '<%= config.bin %> monitor --json',
  ]

  static flags = {
    ...machineOutputFlags,
    interval: Flags.integer({
      char: 'i',
      description: 'Refresh interval in seconds',
      default: 5,
    }),
    once: Flags.boolean({
      description: 'Render once and exit (no refresh loop)',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Monitor)
    const jsonMode = shouldOutputJson(flags)
    const intervalMs = flags.interval * 1000

    const store = new SessionStore()

    const collectSnapshots = (): AgentSnapshot[] => {
      store.reconcile()
      const allSessions = store.list('running')
      const sessions = allSessions.filter(s => isSessionVisibleToCurrentUser(s.sessionName))
      return sessions.map(buildAgentSnapshot)
    }

    if (flags.once || jsonMode) {
      try {
        const snapshots = collectSnapshots()

        if (jsonMode) {
          outputSuccessAsJson({
            timestamp: new Date().toISOString(),
            agents: snapshots.map(s => ({
              agentName: s.agentName,
              ticketId: s.ticketId,
              runner: s.runner,
              task: s.task,
              environment: s.environment,
              status: s.status,
              uptimeMs: s.uptimeMs,
              uptime: s.uptime,
              lastOutput: s.lastOutput,
              gitBranch: s.gitStatus?.branch,
              gitUncommitted: s.gitStatus?.uncommitted,
              sessionName: s.sessionName,
              workdir: s.workdir,
              contextPercent: s.contextPercent,
              contextLevel: s.contextLevel,
            })),
          }, createMetadata('monitor', flags))
          return
        }

        this.log(renderDashboard(snapshots))
      } finally {
        store.close()
      }
      return
    }

    // Continuous refresh mode
    let running = true

    const cleanup = () => {
      running = false
      store.close()
    }

    process.on('SIGINT', () => {
      cleanup()
      // Restore cursor and show exit message
      process.stdout.write('\x1B[?25h')
      this.log('')
      this.log(styles.muted('Monitor stopped.'))
      process.exit(0)
    })

    // Initial render
    process.stdout.write('\x1B[?25l') // Hide cursor
    let snapshots = collectSnapshots()
    process.stdout.write('\x1B[2J\x1B[H') // Clear screen
    process.stdout.write(renderDashboard(snapshots))

    while (running) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, intervalMs)
        const check = setInterval(() => {
          if (!running) {
            clearTimeout(timer)
            clearInterval(check)
            resolve()
          }
        }, 100)
      })

      if (!running) break

      snapshots = collectSnapshots()
      process.stdout.write('\x1B[2J\x1B[H') // Clear screen
      process.stdout.write(renderDashboard(snapshots))
    }
  }
}

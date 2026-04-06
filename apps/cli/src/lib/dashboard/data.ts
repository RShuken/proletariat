/**
 * Dashboard Data Aggregation
 *
 * Gathers data from board, agents, sessions, and PRs into a unified interface
 * for the web dashboard. Enhanced with token usage tracking and tmux peek.
 */

import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { type DatabaseDriver, openDriver } from '../database/driver.js'
import type { Board, Ticket, Column } from '../pmo/types.js'
import { getWorkspaceInfo, getAllAgentsStatus, getAgentTmuxSessions } from '../agents/commands.js'
import type { WorkspaceInfo, AgentStatus } from '../agents/commands.js'
import { ExecutionStorage } from '../execution/index.js'
import {
  getHostTmuxSessionNames,
  parseSessionName,
  getContainerTmuxSessionMap,
  flattenContainerSessions,
  findContainerSessionsByPrefix,
  findSessionForExecution,
  captureTmuxPane,
} from '../execution/session-utils.js'
import { detectSessionStatus, toDashboardStatus } from '../execution/status-detector.js'
import { listOpenPRs } from '../pr/index.js'
import type { PRInfo } from '../pr/index.js'
import type { PMOStorage } from '../pmo/types.js'

// =============================================================================
// Dashboard Data Interface
// =============================================================================

export interface DashboardColumn {
  id: string
  name: string
  position: number
  tickets: DashboardTicket[]
}

export interface DashboardTicket {
  id: string
  title: string
  priority?: string
  category?: string
  assignee?: string
  statusName?: string
  labels: string[]
}

export interface DashboardAgent {
  name: string
  exists: boolean
  branch?: string
  assignedTickets: string[]
  completedTickets: string[]
  hasActiveSessions: boolean
  /** Derived status: working, idle, needs-input, error */
  derivedStatus: 'working' | 'idle' | 'needs-input' | 'error'
  /** Current ticket being worked on (most recent running execution) */
  currentTicket?: string
  /** Elapsed time in seconds since execution started */
  elapsedSeconds?: number
  /** Token usage from execution tracking */
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    model: string | null
    estimatedCostUsd: number
  }
}

export interface DashboardSession {
  sessionId: string
  ticketId: string
  agentName: string
  status: string
  environment: 'host' | 'container'
  source: 'db' | 'discovered'
  containerId?: string
}

export interface DashboardPR {
  number: number
  url: string
  title: string
  headBranch: string
  isDraft: boolean
  ciStatus?: 'success' | 'failure' | 'pending' | 'unknown'
}

/** Tmux pane peek: last N lines of output for a session */
export interface TmuxPeek {
  sessionId: string
  agentName: string
  lines: string[]
}

export interface DashboardData {
  projectId: string
  projectName: string
  timestamp: string
  board: {
    columns: DashboardColumn[]
  }
  agents: DashboardAgent[]
  sessions: DashboardSession[]
  prs: DashboardPR[]
  tmuxPeeks: TmuxPeek[]
}

// =============================================================================
// PR CI Status Cache (gh CLI is slow)
// =============================================================================

let prCacheData: { prs: DashboardPR[]; fetchedAt: number } | null = null
const PR_CACHE_TTL_MS = 30_000

// =============================================================================
// Data Gathering Functions
// =============================================================================

export async function gatherBoardData(
  storage: PMOStorage,
  projectId: string,
): Promise<{ columns: DashboardColumn[] }> {
  try {
    const board: Board = await storage.getBoard(projectId)
    const columns: DashboardColumn[] = board.columns.map((col: Column) => ({
      id: col.id,
      name: col.name,
      position: col.position,
      tickets: (col.tickets || []).map((t: Ticket) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        category: t.category,
        assignee: t.assignee,
        statusName: t.statusName,
        labels: t.labels || [],
      })),
    }))
    return { columns }
  } catch {
    return { columns: [] }
  }
}

export function gatherAgentData(): DashboardAgent[] {
  let executionStorage: ExecutionStorage | null = null
  let db: DatabaseDriver | null = null

  try {
    const workspaceInfo: WorkspaceInfo = getWorkspaceInfo()
    const dbPath = path.join(workspaceInfo.path, '.proletariat', 'workspace.db')
    db = openDriver(dbPath, { foreignKeys: false })
    executionStorage = new ExecutionStorage(db)
  } catch {
    // workspace DB unavailable
  }

  try {
    const workspaceInfo: WorkspaceInfo = getWorkspaceInfo()
    const statuses: AgentStatus[] = getAllAgentsStatus(workspaceInfo)
    return statuses.map((s) => {
      let hasActiveSessions = false
      try {
        hasActiveSessions = getAgentTmuxSessions(s.name).length > 0
      } catch {
        // tmux not available
      }

      // Determine derived status and token usage from executions
      let derivedStatus: DashboardAgent['derivedStatus'] = 'idle'
      let currentTicket: string | undefined
      let elapsedSeconds: number | undefined
      let tokenUsage: DashboardAgent['tokenUsage'] | undefined

      if (executionStorage) {
        try {
          const running = executionStorage.listExecutions({ agentName: s.name, status: 'running' })
          const starting = executionStorage.listExecutions({ agentName: s.name, status: 'starting' })
          const errored = executionStorage.listExecutions({ agentName: s.name, status: 'failed' })
          const active = [...running, ...starting]

          if (active.length > 0) {
            const exec = active[0]
            currentTicket = exec.ticketId
            elapsedSeconds = Math.floor((Date.now() - exec.startedAt.getTime()) / 1000)

            // TKT-031: Use tmux-based status detection for live sessions
            if (exec.sessionId) {
              const isContainer = exec.environment === 'devcontainer' || exec.environment === 'docker'
              const detected = detectSessionStatus(exec.sessionId, isContainer ? exec.containerId : undefined)
              derivedStatus = toDashboardStatus(detected.status)
            } else {
              derivedStatus = 'working'
            }

            if (exec.inputTokens || exec.outputTokens) {
              tokenUsage = {
                inputTokens: exec.inputTokens ?? 0,
                outputTokens: exec.outputTokens ?? 0,
                cacheReadTokens: exec.cacheReadTokens ?? 0,
                cacheCreationTokens: exec.cacheCreationTokens ?? 0,
                model: exec.model ?? null,
                estimatedCostUsd: exec.estimatedCostUsd ?? 0,
              }
            }
          } else if (errored.length > 0 && (!errored[0].completedAt || Date.now() - errored[0].completedAt.getTime() < 300_000)) {
            derivedStatus = 'error'
            currentTicket = errored[0].ticketId
          } else if (hasActiveSessions && s.assignedTickets.length > 0) {
            // Has tmux session but no running execution — might be waiting for input
            derivedStatus = 'needs-input'
            currentTicket = s.assignedTickets[0]
          }

          // Aggregate token usage across recent executions if not from active
          if (!tokenUsage) {
            const recent = executionStorage.listExecutions({ agentName: s.name, limit: 10 })
            let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreation = 0, totalCost = 0
            let lastModel: string | null = null
            for (const exec of recent) {
              totalInput += exec.inputTokens ?? 0
              totalOutput += exec.outputTokens ?? 0
              totalCacheRead += exec.cacheReadTokens ?? 0
              totalCacheCreation += exec.cacheCreationTokens ?? 0
              totalCost += exec.estimatedCostUsd ?? 0
              if (exec.model) lastModel = exec.model
            }
            if (totalInput > 0 || totalOutput > 0) {
              tokenUsage = {
                inputTokens: totalInput,
                outputTokens: totalOutput,
                cacheReadTokens: totalCacheRead,
                cacheCreationTokens: totalCacheCreation,
                model: lastModel,
                estimatedCostUsd: totalCost,
              }
            }
          }
        } catch {
          // execution query failed
        }
      }

      return {
        name: s.name,
        exists: s.exists,
        branch: s.branch,
        assignedTickets: s.assignedTickets,
        completedTickets: s.completedTickets,
        hasActiveSessions,
        derivedStatus,
        currentTicket,
        elapsedSeconds,
        tokenUsage,
      }
    })
  } catch {
    return []
  } finally {
    db?.close()
  }
}

export function gatherSessionData(): DashboardSession[] {
  let executionStorage: ExecutionStorage | null = null
  let db: DatabaseDriver | null = null
  const sessions: DashboardSession[] = []

  try {
    const workspaceInfo = getWorkspaceInfo()
    const dbPath = path.join(workspaceInfo.path, '.proletariat', 'workspace.db')
    db = openDriver(dbPath, { foreignKeys: false })
    executionStorage = new ExecutionStorage(db)
  } catch {
    // Not in workspace — still discover tmux sessions below
  }

  try {
    const runningExecutions = executionStorage?.listExecutions({ status: 'running' }) || []
    const startingExecutions = executionStorage?.listExecutions({ status: 'starting' }) || []
    const activeExecutions = [...runningExecutions, ...startingExecutions]

    executionStorage?.cleanupStaleExecutions()

    const hostTmuxSessions = getHostTmuxSessionNames()
    const containerTmuxSessions = getContainerTmuxSessionMap()
    const allContainerSessions = flattenContainerSessions(containerTmuxSessions)

    const matchedHostSessions = new Set<string>()
    const matchedContainerSessions = new Set<string>()

    for (const exec of activeExecutions) {
      const isContainer = exec.environment === 'devcontainer' || exec.environment === 'docker'
      let exists = false
      let containerId: string | undefined
      let actualSessionId = exec.sessionId

      if (!exec.sessionId) {
        if (isContainer && exec.containerId) {
          const containerSessions = findContainerSessionsByPrefix(containerTmuxSessions, exec.containerId)
          const match = findSessionForExecution(exec.ticketId, exec.agentName, containerSessions)
          if (match) { actualSessionId = match; exists = true; containerId = exec.containerId }
        } else {
          const match = findSessionForExecution(exec.ticketId, exec.agentName, hostTmuxSessions)
          if (match) { actualSessionId = match; exists = true }
        }
        if (!actualSessionId) continue
      } else {
        if (isContainer && exec.containerId) {
          const containerSessions = findContainerSessionsByPrefix(containerTmuxSessions, exec.containerId)
          exists = containerSessions.includes(exec.sessionId)
          containerId = exec.containerId
        } else {
          exists = hostTmuxSessions.includes(exec.sessionId)
        }
      }

      if (exists && actualSessionId) {
        if (isContainer && containerId) {
          matchedContainerSessions.add(`${containerId}:${actualSessionId}`)
        } else {
          matchedHostSessions.add(actualSessionId)
        }
      }

      if (actualSessionId && exists) {
        sessions.push({
          sessionId: actualSessionId,
          ticketId: exec.ticketId,
          agentName: exec.agentName,
          status: exec.status,
          environment: isContainer ? 'container' : 'host',
          source: 'db',
          containerId: isContainer ? exec.containerId : undefined,
        })
      }
    }

    // Discover orphan sessions
    for (const sessionName of hostTmuxSessions) {
      if (matchedHostSessions.has(sessionName)) continue
      const parsed = parseSessionName(sessionName)
      if (parsed) {
        sessions.push({
          sessionId: sessionName,
          ticketId: parsed.ticketId,
          agentName: parsed.agentName,
          status: 'orphan',
          environment: 'host',
          source: 'discovered',
        })
      }
    }

    for (const { sessionName } of allContainerSessions) {
      const key = `${sessionName}`
      // Check all container session entries
      let matched = false
      for (const k of matchedContainerSessions) {
        if (k.endsWith(`:${sessionName}`)) { matched = true; break }
      }
      if (matched) continue
      const parsed = parseSessionName(sessionName)
      if (parsed) {
        sessions.push({
          sessionId: sessionName,
          ticketId: parsed.ticketId,
          agentName: parsed.agentName,
          status: 'orphan',
          environment: 'container',
          source: 'discovered',
        })
      }
    }
  } finally {
    db?.close()
  }

  return sessions
}

export function gatherPRData(): DashboardPR[] {
  const now = Date.now()
  if (prCacheData && (now - prCacheData.fetchedAt) < PR_CACHE_TTL_MS) {
    return prCacheData.prs
  }

  try {
    const openPRs: PRInfo[] = listOpenPRs()

    // Try to get CI status
    let ciMap: Map<number, string> = new Map()
    try {
      const ciResult = execSync(
        'gh pr list --json number,statusCheckRollup',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000 },
      )
      const ciData = JSON.parse(ciResult) as Array<{
        number: number
        statusCheckRollup: Array<{ conclusion: string; state: string }> | null
      }>
      for (const pr of ciData) {
        if (!pr.statusCheckRollup || pr.statusCheckRollup.length === 0) {
          ciMap.set(pr.number, 'unknown')
          continue
        }
        const hasFailure = pr.statusCheckRollup.some(
          (c) => c.conclusion === 'FAILURE' || c.state === 'FAILURE',
        )
        const allSuccess = pr.statusCheckRollup.every(
          (c) => c.conclusion === 'SUCCESS' || c.state === 'SUCCESS',
        )
        const hasPending = pr.statusCheckRollup.some(
          (c) => c.state === 'PENDING' || c.conclusion === '',
        )
        if (hasFailure) ciMap.set(pr.number, 'failure')
        else if (allSuccess) ciMap.set(pr.number, 'success')
        else if (hasPending) ciMap.set(pr.number, 'pending')
        else ciMap.set(pr.number, 'unknown')
      }
    } catch {
      // CI status unavailable
    }

    const prs: DashboardPR[] = openPRs.map((pr) => ({
      number: pr.number,
      url: pr.url,
      title: pr.title,
      headBranch: pr.headBranch,
      isDraft: pr.isDraft,
      ciStatus: (ciMap.get(pr.number) as DashboardPR['ciStatus']) || 'unknown',
    }))

    prCacheData = { prs, fetchedAt: now }
    return prs
  } catch {
    return prCacheData?.prs || []
  }
}

const TMUX_PEEK_LINES = 20

/**
 * Capture last N lines of tmux output for each active session.
 * Returns one TmuxPeek per session that has a live tmux pane.
 */
export function gatherTmuxPeeks(sessions: DashboardSession[]): TmuxPeek[] {
  const peeks: TmuxPeek[] = []
  for (const s of sessions) {
    if (s.status !== 'running' && s.status !== 'starting') continue
    try {
      const output = captureTmuxPane(s.sessionId, TMUX_PEEK_LINES, s.containerId)
      if (output !== null) {
        peeks.push({
          sessionId: s.sessionId,
          agentName: s.agentName,
          lines: output.split('\n').slice(-TMUX_PEEK_LINES),
        })
      }
    } catch {
      // tmux capture failed — skip
    }
  }
  return peeks
}

export async function gatherDashboardData(
  storage: PMOStorage,
  projectId: string,
  projectName: string,
): Promise<DashboardData> {
  const [board, agents, sessions, prs] = await Promise.all([
    gatherBoardData(storage, projectId),
    Promise.resolve(gatherAgentData()),
    Promise.resolve(gatherSessionData()),
    Promise.resolve(gatherPRData()),
  ])

  const tmuxPeeks = gatherTmuxPeeks(sessions)

  return {
    projectId,
    projectName,
    timestamp: new Date().toISOString(),
    board,
    agents,
    sessions,
    prs,
    tmuxPeeks,
  }
}

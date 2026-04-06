/**
 * Ticket Scheduler
 *
 * Manages automatic agent spawning for Ready tickets with capacity control.
 * The scheduler enforces a max_agents limit and priority ordering (P1 > P2 > P3)
 * to prevent overloading the system with too many concurrent agents.
 *
 * Integration points:
 * - Listens for on_agent_completed / on_agent_died on the EventBus
 * - Runs on a 30-second polling interval in the daemon
 * - Gates spawn-agent actions via capacity check
 */

import type Database from 'better-sqlite3'
import { getEventBus } from '../events/event-bus.js'
import type { OrchestrateEngine } from './engine.js'
import { getWorkflowConfig } from '../work-lifecycle/settings.js'

// =============================================================================
// Constants
// =============================================================================

export const DEFAULT_MAX_AGENTS = 3
export const SCHEDULER_POLL_INTERVAL_MS = 30_000
const SETTINGS_KEY_MAX_AGENTS = 'scheduler.max_agents'

/**
 * Priority sort order — lower number = higher priority.
 * Tickets without a recognized priority sort last.
 */
const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  p1: 1,
  medium: 2,
  p2: 2,
  normal: 2,
  low: 3,
  p3: 3,
  none: 4,
}

// =============================================================================
// Scheduler
// =============================================================================

export interface SchedulerOptions {
  engine: OrchestrateEngine
  db: Database.Database
  log: (msg: string) => void
}

export class TicketScheduler {
  private engine: OrchestrateEngine
  private db: Database.Database
  private log: (msg: string) => void
  private unsubscribers: Array<() => void> = []
  private scheduledTickets = new Set<string>()

  constructor(options: SchedulerOptions) {
    this.engine = options.engine
    this.db = options.db
    this.log = options.log
  }

  /**
   * Start listening for agent completion/death events on the EventBus.
   * When an agent finishes, the scheduler checks for the next ready ticket.
   */
  start(): void {
    const bus = getEventBus()

    // When an agent completes or dies, try to schedule the next ticket
    const onComplete = () => {
      // Defer to next tick so the agent_work status has time to update
      setTimeout(() => { void this.tryScheduleNext() }, 1000)
    }

    this.unsubscribers.push(bus.on('on_agent_completed', onComplete))
    this.unsubscribers.push(bus.on('on_agent_died', onComplete))

    this.log('[scheduler] Started — listening for agent completion events')
  }

  /**
   * Stop listening for events.
   */
  stop(): void {
    for (const unsub of this.unsubscribers) {
      unsub()
    }
    this.unsubscribers = []
  }

  /**
   * Get the configured maximum number of concurrent agents.
   */
  getMaxAgents(): number {
    try {
      const row = this.db
        .prepare('SELECT value FROM workspace_settings WHERE key = ?')
        .get(SETTINGS_KEY_MAX_AGENTS) as { value: string } | undefined
      if (row) {
        const parsed = parseInt(row.value, 10)
        if (!isNaN(parsed) && parsed > 0) return parsed
      }
    } catch {
      // workspace_settings table may not exist yet
    }
    return DEFAULT_MAX_AGENTS
  }

  /**
   * Get the number of currently running agents.
   */
  getRunningAgentCount(): number {
    try {
      const row = this.db
        .prepare("SELECT COUNT(*) as count FROM agent_work WHERE status IN ('starting', 'running')")
        .get() as { count: number }
      return row.count
    } catch {
      return 0
    }
  }

  /**
   * Check if there is capacity to spawn another agent.
   */
  hasCapacity(): boolean {
    return this.getRunningAgentCount() < this.getMaxAgents()
  }

  /**
   * Get the next ready ticket ordered by priority.
   * Returns null if no ready tickets are available.
   */
  getNextReadyTicket(): { id: string; title: string; priority: string | null } | null {
    try {
      let readyStatusName: string | null = null
      try {
        const config = getWorkflowConfig(this.db)
        readyStatusName = config.planned
      } catch {
        // pmo_settings may not exist yet
      }

      const tickets = readyStatusName
        ? this.db.prepare(`
            SELECT t.id, t.title, t.priority
            FROM pmo_tickets t
            JOIN pmo_workflow_statuses ws ON t.status_id = ws.id
            WHERE LOWER(ws.name) = LOWER(?)
              AND t.assignee IS NULL
              AND t.id NOT IN (
                SELECT ticket_id FROM agent_work WHERE status IN ('starting', 'running')
              )
          `).all(readyStatusName) as Array<{ id: string; title: string; priority: string | null }>
        : this.db.prepare(`
            SELECT t.id, t.title, t.priority
            FROM pmo_tickets t
            JOIN pmo_workflow_statuses ws ON t.status_id = ws.id
            WHERE ws.category = 'unstarted'
              AND t.assignee IS NULL
              AND t.id NOT IN (
                SELECT ticket_id FROM agent_work WHERE status IN ('starting', 'running')
              )
          `).all() as Array<{ id: string; title: string; priority: string | null }>

      if (tickets.length === 0) return null

      // Sort by priority (P1 > P2 > P3)
      tickets.sort((a, b) => {
        const pa = priorityRank(a.priority)
        const pb = priorityRank(b.priority)
        return pa - pb
      })

      return tickets[0]
    } catch {
      return null
    }
  }

  /**
   * Main scheduling logic: if there's capacity, pick the highest-priority
   * ready ticket and fire on_ticket_ready for it.
   *
   * Returns true if a ticket was scheduled, false otherwise.
   */
  async tryScheduleNext(): Promise<boolean> {
    if (!this.hasCapacity()) {
      const running = this.getRunningAgentCount()
      const max = this.getMaxAgents()
      this.log(`[scheduler] At capacity (${running}/${max} agents) — skipping`)
      return false
    }

    const ticket = this.getNextReadyTicket()
    if (!ticket) {
      return false
    }

    // Prevent scheduling the same ticket twice in rapid succession
    if (this.scheduledTickets.has(ticket.id)) {
      return false
    }
    this.scheduledTickets.add(ticket.id)

    const running = this.getRunningAgentCount()
    const max = this.getMaxAgents()
    this.log(`[scheduler] Scheduling ${ticket.id} (${ticket.priority || 'no priority'}) — ${running}/${max} agents running`)

    await this.engine.fireEvent('on_ticket_ready', {
      event: 'on_ticket_ready',
      ticket: ticket.id,
    })

    return true
  }

  /**
   * Clear the scheduled tickets set — allows re-scheduling tickets that
   * were previously scheduled but whose agents have since completed.
   * Called by the polling loop to allow retries.
   */
  clearScheduledTickets(): void {
    this.scheduledTickets.clear()
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Convert a priority string to a numeric rank for sorting.
 * Lower rank = higher priority.
 */
export function priorityRank(priority: string | null | undefined): number {
  if (!priority) return 99
  const key = priority.toLowerCase().trim()
  return PRIORITY_ORDER[key] ?? 99
}

/**
 * YOLO Auto-Responder
 *
 * Detects stuck prompts in tmux agent sessions and auto-responds based on
 * prompt category and permission mode. Designed for unattended operation
 * where agents run in YOLO/danger mode.
 *
 * Prompt categories:
 * - Permission/safety: auto-send "y" (only in danger mode)
 * - Continue: auto-send "yes"
 * - Plan approval: auto-send "yes" (only in danger mode)
 * - Model selection: NEVER auto-respond (requires human judgment)
 *
 * Safety guardrails:
 * - 10-second cooldown between auto-responses per session
 * - Model selection prompts are always skipped
 * - Every auto-response is logged with timestamp and matched prompt text
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

// =============================================================================
// Constants
// =============================================================================

/** Minimum interval between auto-responses for the same session (ms). */
export const AUTO_RESPOND_COOLDOWN_MS = 10_000

/** Number of tmux pane lines to capture for prompt detection. */
export const PROMPT_CAPTURE_LINES = 30

// =============================================================================
// Prompt Categories & Patterns
// =============================================================================

export type PromptCategory = 'permission' | 'continue' | 'plan_approval' | 'model_selection'

export interface PromptMatch {
  category: PromptCategory
  pattern: RegExp
  matchedText: string
}

/** Patterns that indicate a model selection prompt — NEVER auto-respond. */
const MODEL_SELECTION_PATTERNS: RegExp[] = [
  /Select a model/i,
  /Choose (?:a )?model/i,
  /Which model/i,
  /Pick (?:a )?model/i,
  /Model selection/i,
  /Available models:/i,
]

/** Patterns that indicate a permission/safety prompt — auto-send "y" in danger mode. */
const PERMISSION_PATTERNS: RegExp[] = [
  /Do you want to proceed\?/i,
  /Allow .* to run/i,
  /\(Y\)es.*\(N\)o/i,
  /Press Enter to allow/i,
  /Allow once|Allow always|Deny/i,
  /Do you trust/i,
]

/** Patterns that indicate a "continue?" prompt — auto-send "yes". */
const CONTINUE_PATTERNS: RegExp[] = [
  /Do you want to continue\??/i,
  /Would you like to continue\??/i,
  /Shall I continue\??/i,
  /\bContinue\?\s*$/m,
  /Press enter to continue/i,
  /Would you like me to (?:go ahead|proceed|continue)/i,
  /Should I (?:go ahead|proceed|continue)\??/i,
  /Do you want me to continue/i,
]

/** Patterns that indicate a plan approval prompt — auto-send "yes" in danger mode. */
const PLAN_APPROVAL_PATTERNS: RegExp[] = [
  /Start implementation\??/i,
  /Proceed with this plan\??/i,
  /Execute this plan\??/i,
  /Approve the plan\??/i,
  /Ready to (?:start|begin|implement)\??/i,
  /Shall I (?:start|begin|implement|execute)/i,
  /Do you (?:want|wish) to (?:start|begin|implement|execute)/i,
  /Go ahead with (?:this|the) plan\??/i,
]

/** All pattern groups in priority order (model selection checked first to block). */
const PATTERN_GROUPS: Array<{ category: PromptCategory; patterns: RegExp[] }> = [
  { category: 'model_selection', patterns: MODEL_SELECTION_PATTERNS },
  { category: 'permission', patterns: PERMISSION_PATTERNS },
  { category: 'plan_approval', patterns: PLAN_APPROVAL_PATTERNS },
  { category: 'continue', patterns: CONTINUE_PATTERNS },
]

// =============================================================================
// Types
// =============================================================================

export interface AutoRespondAction {
  timestamp: Date
  sessionId: string
  executionId: string
  agentName: string
  ticketId: string
  category: PromptCategory
  response: string
  matchedText: string
}

export interface AutoResponderDeps {
  captureTmuxPane: (sessionId: string, lines: number, containerId?: string) => string | null
  sendTmuxMessage: (sessionId: string, message: string, containerId?: string) => void
}

export interface AutoResponderOptions {
  /** Injectable dependencies for testing */
  deps: AutoResponderDeps
  /** Logger function */
  log?: (msg: string) => void
  /** Cooldown between auto-responses per session (ms) */
  cooldownMs?: number
  /** Log file path for auto-response actions */
  logFilePath?: string
}

export interface SessionInfo {
  executionId: string
  sessionId: string
  agentName: string
  ticketId: string
  permissionMode: 'danger' | 'safe'
  containerId?: string
}

// =============================================================================
// Auto-Responder
// =============================================================================

export class AutoResponder {
  private deps: AutoResponderDeps
  private log: (msg: string) => void
  private cooldownMs: number
  private logFilePath: string | null

  /** Tracks last auto-response time per session ID. */
  private lastResponseTime = new Map<string, number>()

  constructor(options: AutoResponderOptions) {
    this.deps = options.deps
    this.log = options.log ?? (() => {})
    this.cooldownMs = options.cooldownMs ?? AUTO_RESPOND_COOLDOWN_MS
    this.logFilePath = options.logFilePath ?? null
  }

  /**
   * Set the log file path for auto-response actions.
   */
  setLogFile(logPath: string): void {
    this.logFilePath = logPath
    const dir = path.dirname(logPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  /**
   * Check a single session for stuck prompts and auto-respond if appropriate.
   * Returns the action taken, or null if no action was needed.
   */
  check(session: SessionInfo): AutoRespondAction | null {
    // Cooldown check
    const lastResponse = this.lastResponseTime.get(session.sessionId)
    if (lastResponse && Date.now() - lastResponse < this.cooldownMs) {
      return null
    }

    // Capture pane content
    const paneContent = this.deps.captureTmuxPane(
      session.sessionId, PROMPT_CAPTURE_LINES, session.containerId,
    )
    if (!paneContent) return null

    // Classify the prompt
    const match = classifyPrompt(paneContent)
    if (!match) return null

    // Determine response based on category and permission mode
    const response = this.determineResponse(match, session.permissionMode)
    if (!response) return null

    // Send the response
    try {
      this.deps.sendTmuxMessage(session.sessionId, response, session.containerId)
      this.lastResponseTime.set(session.sessionId, Date.now())

      const action: AutoRespondAction = {
        timestamp: new Date(),
        sessionId: session.sessionId,
        executionId: session.executionId,
        agentName: session.agentName,
        ticketId: session.ticketId,
        category: match.category,
        response,
        matchedText: match.matchedText,
      }

      this.logAction(action)
      return action
    } catch (error) {
      this.log(
        `[auto-responder] Failed to send response to ${session.agentName}: ` +
        `${error instanceof Error ? error.message : error}`,
      )
      return null
    }
  }

  /**
   * Determine the appropriate response for a matched prompt.
   * Returns the response string, or null if we should NOT respond.
   */
  private determineResponse(
    match: PromptMatch,
    permissionMode: 'danger' | 'safe',
  ): string | null {
    switch (match.category) {
      case 'model_selection':
        // NEVER auto-respond to model selection
        return null

      case 'permission':
        // Only in danger mode
        return permissionMode === 'danger' ? 'y' : null

      case 'plan_approval':
        // Only in danger mode
        return permissionMode === 'danger' ? 'yes' : null

      case 'continue':
        // Always auto-respond to continue prompts
        return 'yes'
    }
  }

  /**
   * Log an auto-response action to the dedicated log file and console.
   */
  private logAction(action: AutoRespondAction): void {
    const entry = {
      timestamp: action.timestamp.toISOString(),
      action: 'auto_respond',
      category: action.category,
      executionId: action.executionId,
      agentName: action.agentName,
      ticketId: action.ticketId,
      sessionId: action.sessionId,
      response: action.response,
      matchedText: action.matchedText,
    }

    this.log(
      `[auto-responder] ${action.category}: ${action.agentName} (${action.ticketId}) — ` +
      `sent "${action.response}" for: ${action.matchedText}`,
    )

    if (this.logFilePath) {
      try {
        fs.appendFileSync(this.logFilePath, JSON.stringify(entry) + '\n')
      } catch {
        // Best effort
      }
    }
  }

  /**
   * Clean up cooldown tracking for sessions that are no longer active.
   */
  cleanupSessions(activeSessionIds: Set<string>): void {
    for (const sessionId of this.lastResponseTime.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        this.lastResponseTime.delete(sessionId)
      }
    }
  }

  /**
   * Reset internal state. Useful for testing.
   */
  reset(): void {
    this.lastResponseTime.clear()
  }
}

// =============================================================================
// Prompt Classification (exported for testing)
// =============================================================================

/**
 * Classify tmux pane content into a prompt category.
 * Returns the first matching category (model_selection checked first to block).
 */
export function classifyPrompt(paneContent: string): PromptMatch | null {
  for (const group of PATTERN_GROUPS) {
    for (const pattern of group.patterns) {
      const match = pattern.exec(paneContent)
      if (match) {
        return {
          category: group.category,
          pattern,
          matchedText: match[0],
        }
      }
    }
  }
  return null
}

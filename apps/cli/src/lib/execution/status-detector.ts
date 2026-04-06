/**
 * Session Status Detector
 *
 * Captures tmux pane output, strips ANSI codes, and classifies session status.
 * Inspired by amux's ANSI-stripped tmux parsing for status detection.
 *
 * Used by: session list, monitor, web dashboard, and notification triggers.
 */

import { captureTmuxPane } from './session-utils.js'

// =============================================================================
// Types
// =============================================================================

/**
 * Detected session status based on tmux pane output analysis.
 *
 * - WORKING:     Tool use indicators visible (Read, Write, Edit, Bash, Grep, Glob, etc.)
 * - NEEDS_INPUT: Permission prompt visible (Allow, Approve, y/n, Yes/No)
 * - IDLE:        No meaningful activity detected; shell prompt or stale output
 * - ERROR:       Error indicators visible (Error:, FAIL, crashed, ENOENT, etc.)
 * - COMPLETE:    Session prompt returned after task summary; agent work finished
 * - UNKNOWN:     Cannot determine status (no output or unrecognizable content)
 */
export type SessionStatus = 'WORKING' | 'NEEDS_INPUT' | 'IDLE' | 'ERROR' | 'COMPLETE' | 'UNKNOWN'

export interface SessionStatusResult {
  status: SessionStatus
  /** The raw (ANSI-stripped) pane content used for detection */
  rawOutput: string | null
  /** Which pattern matched (for debugging/logging) */
  matchedPattern?: string
  /** Timestamp of detection */
  detectedAt: Date
}

// =============================================================================
// Configuration
// =============================================================================

export interface StatusDetectorConfig {
  /** Number of scrollback lines to capture from tmux pane (default: 30) */
  captureLines: number
  /** Number of trailing lines to analyze for status patterns (default: 15) */
  analyzeLines: number
  /** Seconds of no new output before considering IDLE (default: 120) */
  idleThresholdSeconds: number
}

export const DEFAULT_DETECTOR_CONFIG: StatusDetectorConfig = {
  captureLines: 30,
  analyzeLines: 15,
  idleThresholdSeconds: 120,
}

// =============================================================================
// ANSI Stripping
// =============================================================================

/**
 * Strip ANSI escape codes from a string.
 * Handles CSI sequences, OSC sequences, and other common terminal escapes.
 */
export function stripAnsi(text: string): string {
  // CSI sequences: ESC [ ... final_byte
  // OSC sequences: ESC ] ... ST (ST = ESC \ or BEL)
  // Other ESC sequences: ESC followed by a single char
  return text
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')     // CSI sequences (colors, cursor, etc.)
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '') // OSC sequences (title, etc.)
    .replace(/\x1B[()][0-9A-B]/g, '')           // Character set selection
    .replace(/\x1B[=>]/g, '')                    // Keypad mode
    .replace(/\x1B./g, '')                       // Any remaining ESC + char
    .replace(/[\x00-\x08\x0E-\x1F]/g, '')       // Control chars (except \t \n \r)
}

// =============================================================================
// Pattern Definitions
// =============================================================================

/**
 * Tool use indicators — Claude Code tool names and execution patterns.
 * These indicate the agent is actively working.
 */
const TOOL_USE_PATTERNS: RegExp[] = [
  /(?:^|\s)(?:Read|Write|Edit|Bash|Grep|Glob|Search|TodoWrite|WebFetch|WebSearch)\s*[(\[]/i,
  /⏺\s+(?:Reading|Writing|Editing|Running|Searching|Creating|Updating)/i,
  /esc to interrupt/i,
  /\$ .{3,}/,                         // Shell command execution ($ followed by command)
  /running\s+(?:command|test|build)/i,
  /tokens?\s*[|│]\s*\d+/,            // Token counter with pipe (active streaming)
]

/**
 * Permission prompt patterns — indicate the agent needs human input.
 */
const NEEDS_INPUT_PATTERNS: RegExp[] = [
  /\bAllow\b.*\?\s*$/m,
  /\bApprove\b/i,
  /\b(?:allow|deny)\b.*(?:tool|command|operation)/i,
  /(?:^|\s)(?:Yes|No)\s*$/m,
  /\(y\/n\)/i,
  /\(Y\/n\)/,
  /\(yes\/no\)/i,
  /Do you want to (?:proceed|continue)\?/i,
  /Press (?:Enter|Return) to (?:continue|confirm)/i,
  /waiting for (?:input|approval|permission)/i,
  /(?:your )?permission (?:is )?(?:required|needed)/i,
]

/**
 * Error indicator patterns.
 */
const ERROR_PATTERNS: RegExp[] = [
  /\bError:\s+\S/,
  /\bFAIL(?:ED|URE)?\b/,
  /\bcrashed?\b/i,
  /\bENOENT\b/,
  /\bEACCES\b/,
  /\bECONNREFUSED\b/,
  /\bSegmentation fault\b/i,
  /\bpanic(?:ked)?\b/i,
  /\bfatal(?:\s+error)?\b/i,
  /\bUnhandled(?:Rejection|Exception)\b/,
  /\bstack\s*overflow\b/i,
  /\bout of memory\b/i,
  /\bcommand not found\b/i,
  /\bkilled\b/i,
  /\bEXIT\s+(?:[1-9]|[1-9]\d|1\d{2}|2[0-4]\d|25[0-5])\b/, // Non-zero exit codes
]

/**
 * Completion patterns — agent has finished its task.
 */
const COMPLETE_PATTERNS: RegExp[] = [
  /agent work complete/i,
  /work ready/i,
  /task (?:completed?|finished|done)/i,
  /all (?:tasks?|changes?) (?:completed?|finished|done)/i,
  /(?:successfully|successfully) (?:completed?|finished|committed|pushed)/i,
  /PR (?:created|opened|submitted)/i,
  /commit(?:ted)?\s+(?:and\s+)?push(?:ed)?/i,
]

/**
 * Shell prompt patterns — indicate the session is idle at a prompt.
 */
const IDLE_PROMPT_PATTERNS: RegExp[] = [
  /[$❯#>]\s*$/,                      // Common prompt endings
  /^\s*\$\s*$/,                       // Bare $ prompt
  /^\s*❯\s*$/,                        // Bare ❯ prompt
  /^\s*>\s*$/,                         // Bare > prompt
]

// =============================================================================
// Core Detection
// =============================================================================

/**
 * Classify session status from raw (pre-stripped) pane content.
 *
 * Priority order (highest to lowest):
 * 1. NEEDS_INPUT — urgent, human action required
 * 2. ERROR — something broke
 * 3. COMPLETE — agent finished its work
 * 4. WORKING — agent is actively doing things
 * 5. IDLE — shell prompt visible, no activity
 * 6. UNKNOWN — cannot determine
 */
export function classifyStatus(
  paneContent: string | null,
  config: StatusDetectorConfig = DEFAULT_DETECTOR_CONFIG,
): SessionStatusResult {
  const detectedAt = new Date()

  if (!paneContent || paneContent.trim().length === 0) {
    return { status: 'UNKNOWN', rawOutput: null, detectedAt }
  }

  const stripped = stripAnsi(paneContent)
  const lines = stripped.split('\n')
  const tailLines = lines.slice(-config.analyzeLines)
  const tail = tailLines.join('\n')

  // 1. NEEDS_INPUT — highest priority, human must act
  for (const pattern of NEEDS_INPUT_PATTERNS) {
    if (pattern.test(tail)) {
      return { status: 'NEEDS_INPUT', rawOutput: stripped, matchedPattern: pattern.source, detectedAt }
    }
  }

  // 2. ERROR — check for error indicators
  //    Only match errors in the last few lines to avoid matching old errors
  //    that scrolled through during normal operation
  const recentLines = tailLines.slice(-5).join('\n')
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(recentLines)) {
      return { status: 'ERROR', rawOutput: stripped, matchedPattern: pattern.source, detectedAt }
    }
  }

  // 3. COMPLETE — agent finished its work
  for (const pattern of COMPLETE_PATTERNS) {
    if (pattern.test(tail)) {
      return { status: 'COMPLETE', rawOutput: stripped, matchedPattern: pattern.source, detectedAt }
    }
  }

  // 4. WORKING — tool use or active processing indicators
  for (const pattern of TOOL_USE_PATTERNS) {
    if (pattern.test(tail)) {
      return { status: 'WORKING', rawOutput: stripped, matchedPattern: pattern.source, detectedAt }
    }
  }

  // 5. IDLE — shell prompt visible at end of output
  const lastNonEmpty = [...tailLines].reverse().find(l => l.trim().length > 0) || ''
  for (const pattern of IDLE_PROMPT_PATTERNS) {
    if (pattern.test(lastNonEmpty)) {
      return { status: 'IDLE', rawOutput: stripped, matchedPattern: pattern.source, detectedAt }
    }
  }

  // 6. UNKNOWN — cannot determine
  return { status: 'UNKNOWN', rawOutput: stripped, detectedAt }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Detect the status of a tmux session by capturing and analyzing pane output.
 *
 * @param sessionName - The tmux session name to inspect
 * @param containerId - Optional container ID for container-based sessions
 * @param config - Optional configuration overrides
 * @returns SessionStatusResult with detected status and metadata
 */
export function detectSessionStatus(
  sessionName: string,
  containerId?: string,
  config: StatusDetectorConfig = DEFAULT_DETECTOR_CONFIG,
): SessionStatusResult {
  const paneContent = captureTmuxPane(sessionName, config.captureLines, containerId)
  return classifyStatus(paneContent, config)
}

/**
 * Map SessionStatus to the dashboard's derivedStatus values.
 * The web dashboard uses a different status vocabulary.
 */
export function toDashboardStatus(status: SessionStatus): 'working' | 'idle' | 'needs-input' | 'error' {
  switch (status) {
    case 'WORKING':     return 'working'
    case 'NEEDS_INPUT': return 'needs-input'
    case 'ERROR':       return 'error'
    case 'COMPLETE':    return 'idle'  // Completed agents show as idle (no action needed)
    case 'IDLE':        return 'idle'
    case 'UNKNOWN':     return 'idle'
  }
}

/**
 * Map SessionStatus to notification event names.
 * Returns the event name to fire, or null if no notification is warranted.
 */
export function toNotificationEvent(status: SessionStatus): string | null {
  switch (status) {
    case 'NEEDS_INPUT': return 'on_agent_needs_input'
    case 'ERROR':       return 'on_agent_died'
    case 'COMPLETE':    return 'on_agent_completed'
    default:            return null
  }
}

/**
 * Fire a notification event on the EventBus when a session status changes
 * to a notifiable state (NEEDS_INPUT, ERROR, COMPLETE).
 *
 * Callers (e.g., session health watch, session watcher) should track
 * previous status per session and only call this on status transitions
 * to avoid duplicate notifications.
 *
 * @param status - The detected session status
 * @param context - Session context for the notification payload
 * @returns true if a notification event was emitted, false otherwise
 */
export async function fireStatusNotification(
  status: SessionStatus,
  context: { ticketId: string; agentName: string; sessionId: string; containerId?: string },
): Promise<boolean> {
  const eventName = toNotificationEvent(status)
  if (!eventName) return false

  try {
    const { getEventBus } = await import('../events/event-bus.js')
    const bus = getEventBus()
    bus.emit(eventName as Parameters<typeof bus.emit>[0], {
      ticketId: context.ticketId,
      agentName: context.agentName,
      sessionId: context.sessionId,
      containerId: context.containerId,
      detectedStatus: status,
      timestamp: new Date(),
    })
    return true
  } catch {
    // EventBus not available (e.g., running outside of full CLI context)
    return false
  }
}

/**
 * Context Usage Monitor
 *
 * Tracks each agent's context window usage by parsing Claude Code JSONL logs.
 * Calculates percentage of context window used based on model limits and
 * provides warning/compact thresholds.
 *
 * Model context windows:
 * - Opus 4.6/4.5: 1,000,000 tokens
 * - Sonnet 4.6/4.5: 200,000 tokens
 * - Haiku 4.5: 200,000 tokens
 */

import * as path from 'node:path'
import {
  findSessionLogPath,
  parseSessionTokensSync,
} from './token-parser.js'
import type { TokenUsage } from './token-parser.js'

// =============================================================================
// Constants
// =============================================================================

/** Context window sizes by model prefix (tokens). */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-6': 1_000_000,
  'claude-opus-4-5': 1_000_000,
  'claude-sonnet-4-6': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,
}

/** Default context window if model not recognized. */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** Warning threshold: emit warning when context usage exceeds this fraction. */
export const CONTEXT_WARNING_THRESHOLD = 0.80

/** Compact threshold: auto-send /compact when context usage exceeds this fraction. */
export const CONTEXT_COMPACT_THRESHOLD = 0.90

/** Minimum interval between auto-compact commands per session (ms). 5 minutes. */
export const COMPACT_COOLDOWN_MS = 5 * 60 * 1000

// =============================================================================
// Types
// =============================================================================

export type ContextLevel = 'normal' | 'warning' | 'critical'

export interface ContextUsage {
  /** Total input tokens (input + cache read). */
  totalInputTokens: number
  /** Context window size for the detected model. */
  contextWindow: number
  /** Usage as a fraction 0-1. */
  usageRatio: number
  /** Usage as a percentage 0-100. */
  usagePercent: number
  /** Severity level based on thresholds. */
  level: ContextLevel
  /** Detected model name, if any. */
  model: string | null
  /** Full token usage data from the session log. */
  tokens: TokenUsage
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Resolve the context window size for a given model.
 */
export function getContextWindow(model: string | null): number {
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

/**
 * Determine context usage level based on thresholds.
 */
export function getContextLevel(usageRatio: number): ContextLevel {
  if (usageRatio >= CONTEXT_COMPACT_THRESHOLD) return 'critical'
  if (usageRatio >= CONTEXT_WARNING_THRESHOLD) return 'warning'
  return 'normal'
}

/**
 * Calculate context usage from token data and model.
 */
export function calculateContextUsage(tokens: TokenUsage): ContextUsage {
  const totalInputTokens = tokens.inputTokens + tokens.cacheReadTokens
  const contextWindow = getContextWindow(tokens.model)
  const usageRatio = contextWindow > 0 ? totalInputTokens / contextWindow : 0
  const usagePercent = Math.round(usageRatio * 100)
  const level = getContextLevel(usageRatio)

  return {
    totalInputTokens,
    contextWindow,
    usageRatio,
    usagePercent,
    level,
    model: tokens.model,
    tokens,
  }
}

/**
 * Get context usage for a session by parsing its JSONL log.
 *
 * @param sessionId - The Claude Code session ID
 * @param cwd - Optional working directory hint for log discovery
 * @returns ContextUsage or null if the log cannot be found/parsed
 */
export function getContextUsage(sessionId: string, cwd?: string): ContextUsage | null {
  const logPath = findSessionLogPath(sessionId, cwd)
  if (!logPath) return null

  const tokens = parseSessionTokensSync(logPath)
  return calculateContextUsage(tokens)
}

/**
 * Get context usage from an explicit log path.
 */
export function getContextUsageFromLog(logPath: string): ContextUsage {
  const tokens = parseSessionTokensSync(logPath)
  return calculateContextUsage(tokens)
}

/**
 * Format context usage as a human-readable string.
 * e.g. "45%" or "92% [!]"
 */
export function formatContextPercent(usage: ContextUsage): string {
  const pct = `${usage.usagePercent}%`
  if (usage.level === 'critical') return `${pct} [COMPACT]`
  if (usage.level === 'warning') return `${pct} [!]`
  return pct
}

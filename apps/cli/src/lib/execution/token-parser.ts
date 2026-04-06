/**
 * Token Parser
 *
 * Parses Claude Code JSONL session logs to extract token usage data.
 * JSONL files are stored at ~/.claude/projects/-{path}/{sessionId}.jsonl
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as readline from 'node:readline'

// =============================================================================
// Types
// =============================================================================

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  model: string | null
  estimatedCostUsd: number
}

interface JSONLAssistantEntry {
  type: 'assistant'
  message?: {
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

interface JSONLToolUseEntry {
  type: 'tool_use'
  message?: {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

type JSONLEntry = JSONLAssistantEntry | JSONLToolUseEntry | { type: string }

// =============================================================================
// Pricing (per million tokens)
// =============================================================================

const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheCreation: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-sonnet-4-5-20250514': { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-opus-4-6': { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  'claude-opus-4-5-20250514': { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 },
}

// Default to Sonnet pricing if model not recognized
const DEFAULT_PRICING = PRICING['claude-sonnet-4-6']

function getPricing(model: string | null) {
  if (!model) return DEFAULT_PRICING
  // Try exact match first, then prefix match
  if (PRICING[model]) return PRICING[model]
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model.startsWith(key.split('-').slice(0, -1).join('-'))) return pricing
  }
  // Infer from model name
  if (model.includes('opus')) return PRICING['claude-opus-4-6']
  if (model.includes('haiku')) return PRICING['claude-haiku-4-5-20251001']
  return DEFAULT_PRICING
}

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  model: string | null,
): number {
  const pricing = getPricing(model)
  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output +
    (cacheReadTokens / 1_000_000) * pricing.cacheRead +
    (cacheCreationTokens / 1_000_000) * pricing.cacheCreation
  )
}

// =============================================================================
// JSONL Discovery
// =============================================================================

/**
 * Find JSONL log files for a Claude Code session.
 * Claude Code stores logs at ~/.claude/projects/-{cwd-with-dashes}/{sessionId}.jsonl
 */
export function findSessionLogPath(sessionId: string, cwd?: string): string | null {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects')
  if (!fs.existsSync(claudeDir)) return null

  // If cwd provided, try the specific project directory
  if (cwd) {
    const projectDir = '-' + cwd.replace(/\//g, '-')
    const logPath = path.join(claudeDir, projectDir, `${sessionId}.jsonl`)
    if (fs.existsSync(logPath)) return logPath
  }

  // Search all project directories for the session
  try {
    const dirs = fs.readdirSync(claudeDir, { withFileTypes: true })
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      const logPath = path.join(claudeDir, dir.name, `${sessionId}.jsonl`)
      if (fs.existsSync(logPath)) return logPath
    }
  } catch {
    // Directory not readable
  }

  return null
}

// =============================================================================
// JSONL Parsing
// =============================================================================

/**
 * Parse a JSONL log file and extract total token usage.
 * Reads the file line-by-line to handle large files efficiently.
 */
export async function parseSessionTokens(logPath: string): Promise<TokenUsage> {
  const result: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: null,
    estimatedCostUsd: 0,
  }

  if (!fs.existsSync(logPath)) return result

  const stream = fs.createReadStream(logPath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  for await (const line of rl) {
    if (!line.trim()) continue

    try {
      const entry = JSON.parse(line) as JSONLEntry

      if (entry.type === 'assistant' || entry.type === 'tool_use') {
        const usage = (entry as JSONLAssistantEntry | JSONLToolUseEntry).message?.usage
        if (usage) {
          result.inputTokens += usage.input_tokens || 0
          result.outputTokens += usage.output_tokens || 0
          result.cacheReadTokens += usage.cache_read_input_tokens || 0
          result.cacheCreationTokens += usage.cache_creation_input_tokens || 0
        }

        // Capture model from assistant messages
        if (entry.type === 'assistant') {
          const model = (entry as JSONLAssistantEntry).message?.model
          if (model) result.model = model
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  result.estimatedCostUsd = calculateCost(
    result.inputTokens,
    result.outputTokens,
    result.cacheReadTokens,
    result.cacheCreationTokens,
    result.model,
  )

  return result
}

/**
 * Synchronous version for simpler call sites.
 * Reads entire file into memory — use parseSessionTokens for large files.
 */
export function parseSessionTokensSync(logPath: string): TokenUsage {
  const result: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: null,
    estimatedCostUsd: 0,
  }

  if (!fs.existsSync(logPath)) return result

  const content = fs.readFileSync(logPath, 'utf-8')
  const lines = content.split('\n')

  for (const line of lines) {
    if (!line.trim()) continue

    try {
      const entry = JSON.parse(line) as JSONLEntry

      if (entry.type === 'assistant' || entry.type === 'tool_use') {
        const usage = (entry as JSONLAssistantEntry | JSONLToolUseEntry).message?.usage
        if (usage) {
          result.inputTokens += usage.input_tokens || 0
          result.outputTokens += usage.output_tokens || 0
          result.cacheReadTokens += usage.cache_read_input_tokens || 0
          result.cacheCreationTokens += usage.cache_creation_input_tokens || 0
        }

        if (entry.type === 'assistant') {
          const model = (entry as JSONLAssistantEntry).message?.model
          if (model) result.model = model
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  result.estimatedCostUsd = calculateCost(
    result.inputTokens,
    result.outputTokens,
    result.cacheReadTokens,
    result.cacheCreationTokens,
    result.model,
  )

  return result
}

// =============================================================================
// Formatting Helpers
// =============================================================================

export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`
  return String(count)
}

export function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(4)}`
}

import { expect } from 'chai'
import {
  getContextWindow,
  getContextLevel,
  calculateContextUsage,
  formatContextPercent,
  MODEL_CONTEXT_WINDOWS,
  DEFAULT_CONTEXT_WINDOW,
  CONTEXT_WARNING_THRESHOLD,
  CONTEXT_COMPACT_THRESHOLD,
  COMPACT_COOLDOWN_MS,
} from '../../src/lib/execution/context-monitor.js'
import type { ContextUsage, ContextLevel } from '../../src/lib/execution/context-monitor.js'
import type { TokenUsage } from '../../src/lib/execution/token-parser.js'

/**
 * Unit tests for context-monitor.ts
 *
 * Tests cover:
 * - Context window resolution by model name
 * - Context level determination (normal/warning/critical)
 * - Context usage calculation from token data
 * - Formatting of context percentage display
 * - Threshold constants are correct
 * - Cooldown constant is 5 minutes
 */

// =============================================================================
// Helpers
// =============================================================================

function makeTokens(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: null,
    estimatedCostUsd: 0,
    ...overrides,
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('context-monitor', () => {
  describe('constants', () => {
    it('warning threshold is 80%', () => {
      expect(CONTEXT_WARNING_THRESHOLD).to.equal(0.80)
    })

    it('compact threshold is 90%', () => {
      expect(CONTEXT_COMPACT_THRESHOLD).to.equal(0.90)
    })

    it('cooldown is 5 minutes', () => {
      expect(COMPACT_COOLDOWN_MS).to.equal(5 * 60 * 1000)
    })

    it('default context window is 200K', () => {
      expect(DEFAULT_CONTEXT_WINDOW).to.equal(200_000)
    })
  })

  describe('getContextWindow', () => {
    it('returns 1M for opus models', () => {
      expect(getContextWindow('claude-opus-4-6')).to.equal(1_000_000)
      expect(getContextWindow('claude-opus-4-5')).to.equal(1_000_000)
    })

    it('returns 200K for sonnet models', () => {
      expect(getContextWindow('claude-sonnet-4-6')).to.equal(200_000)
      expect(getContextWindow('claude-sonnet-4-5')).to.equal(200_000)
    })

    it('returns 200K for haiku models', () => {
      expect(getContextWindow('claude-haiku-4-5')).to.equal(200_000)
    })

    it('infers from model name containing opus', () => {
      expect(getContextWindow('claude-opus-4-6-20260101')).to.equal(1_000_000)
    })

    it('infers from model name containing sonnet', () => {
      expect(getContextWindow('claude-sonnet-4-6-20260101')).to.equal(200_000)
    })

    it('returns default for null model', () => {
      expect(getContextWindow(null)).to.equal(DEFAULT_CONTEXT_WINDOW)
    })

    it('returns default for unknown model', () => {
      expect(getContextWindow('unknown-model-v1')).to.equal(DEFAULT_CONTEXT_WINDOW)
    })
  })

  describe('getContextLevel', () => {
    it('returns normal below 80%', () => {
      expect(getContextLevel(0)).to.equal('normal')
      expect(getContextLevel(0.5)).to.equal('normal')
      expect(getContextLevel(0.79)).to.equal('normal')
    })

    it('returns warning at exactly 80%', () => {
      expect(getContextLevel(0.80)).to.equal('warning')
    })

    it('returns warning between 80% and 90%', () => {
      expect(getContextLevel(0.85)).to.equal('warning')
      expect(getContextLevel(0.89)).to.equal('warning')
    })

    it('returns critical at exactly 90%', () => {
      expect(getContextLevel(0.90)).to.equal('critical')
    })

    it('returns critical above 90%', () => {
      expect(getContextLevel(0.95)).to.equal('critical')
      expect(getContextLevel(1.0)).to.equal('critical')
    })
  })

  describe('calculateContextUsage', () => {
    it('calculates usage from input + cache read tokens', () => {
      const tokens = makeTokens({
        inputTokens: 100_000,
        cacheReadTokens: 50_000,
        model: 'claude-sonnet-4-6',
      })
      const usage = calculateContextUsage(tokens)

      expect(usage.totalInputTokens).to.equal(150_000)
      expect(usage.contextWindow).to.equal(200_000)
      expect(usage.usagePercent).to.equal(75)
      expect(usage.level).to.equal('normal')
    })

    it('returns warning level at 80%+ usage', () => {
      const tokens = makeTokens({
        inputTokens: 160_000,
        cacheReadTokens: 0,
        model: 'claude-sonnet-4-6',
      })
      const usage = calculateContextUsage(tokens)

      expect(usage.usagePercent).to.equal(80)
      expect(usage.level).to.equal('warning')
    })

    it('returns critical level at 90%+ usage', () => {
      const tokens = makeTokens({
        inputTokens: 180_000,
        cacheReadTokens: 0,
        model: 'claude-sonnet-4-6',
      })
      const usage = calculateContextUsage(tokens)

      expect(usage.usagePercent).to.equal(90)
      expect(usage.level).to.equal('critical')
    })

    it('uses 1M window for opus models', () => {
      const tokens = makeTokens({
        inputTokens: 500_000,
        cacheReadTokens: 0,
        model: 'claude-opus-4-6',
      })
      const usage = calculateContextUsage(tokens)

      expect(usage.contextWindow).to.equal(1_000_000)
      expect(usage.usagePercent).to.equal(50)
      expect(usage.level).to.equal('normal')
    })

    it('opus at 850K is warning (85%)', () => {
      const tokens = makeTokens({
        inputTokens: 850_000,
        cacheReadTokens: 0,
        model: 'claude-opus-4-6',
      })
      const usage = calculateContextUsage(tokens)

      expect(usage.usagePercent).to.equal(85)
      expect(usage.level).to.equal('warning')
    })

    it('opus at 950K is critical (95%)', () => {
      const tokens = makeTokens({
        inputTokens: 950_000,
        cacheReadTokens: 0,
        model: 'claude-opus-4-6',
      })
      const usage = calculateContextUsage(tokens)

      expect(usage.usagePercent).to.equal(95)
      expect(usage.level).to.equal('critical')
    })

    it('handles zero tokens', () => {
      const tokens = makeTokens({ model: 'claude-sonnet-4-6' })
      const usage = calculateContextUsage(tokens)

      expect(usage.totalInputTokens).to.equal(0)
      expect(usage.usagePercent).to.equal(0)
      expect(usage.level).to.equal('normal')
    })

    it('uses default window for null model', () => {
      const tokens = makeTokens({ inputTokens: 100_000 })
      const usage = calculateContextUsage(tokens)

      expect(usage.contextWindow).to.equal(DEFAULT_CONTEXT_WINDOW)
    })

    it('preserves original token data in tokens field', () => {
      const tokens = makeTokens({
        inputTokens: 10_000,
        outputTokens: 5_000,
        cacheReadTokens: 2_000,
        cacheCreationTokens: 1_000,
        model: 'claude-sonnet-4-6',
        estimatedCostUsd: 0.05,
      })
      const usage = calculateContextUsage(tokens)

      expect(usage.tokens).to.deep.equal(tokens)
    })
  })

  describe('formatContextPercent', () => {
    it('formats normal level without suffix', () => {
      const usage = calculateContextUsage(makeTokens({
        inputTokens: 50_000,
        model: 'claude-sonnet-4-6',
      }))
      expect(formatContextPercent(usage)).to.equal('25%')
    })

    it('formats warning level with [!] suffix', () => {
      const usage = calculateContextUsage(makeTokens({
        inputTokens: 170_000,
        model: 'claude-sonnet-4-6',
      }))
      expect(formatContextPercent(usage)).to.equal('85% [!]')
    })

    it('formats critical level with [COMPACT] suffix', () => {
      const usage = calculateContextUsage(makeTokens({
        inputTokens: 190_000,
        model: 'claude-sonnet-4-6',
      }))
      expect(formatContextPercent(usage)).to.equal('95% [COMPACT]')
    })
  })
})

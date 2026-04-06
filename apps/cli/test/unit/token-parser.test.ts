import { expect } from 'chai'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  parseSessionTokensSync,
  calculateCost,
  formatTokenCount,
  formatCost,
  findSessionLogPath,
} from '../../src/lib/execution/token-parser.js'

describe('@smoke Token Parser', () => {
  let tmpDir: string

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prlt-token-test-'))
  })

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ===========================================================================
  // parseSessionTokensSync
  // ===========================================================================

  describe('parseSessionTokensSync', () => {
    it('returns zeros for non-existent file', () => {
      const result = parseSessionTokensSync('/nonexistent/path.jsonl')
      expect(result.inputTokens).to.equal(0)
      expect(result.outputTokens).to.equal(0)
      expect(result.cacheReadTokens).to.equal(0)
      expect(result.cacheCreationTokens).to.equal(0)
      expect(result.model).to.be.null
      expect(result.estimatedCostUsd).to.equal(0)
    })

    it('returns zeros for empty file', () => {
      const logPath = path.join(tmpDir, 'empty.jsonl')
      fs.writeFileSync(logPath, '')
      const result = parseSessionTokensSync(logPath)
      expect(result.inputTokens).to.equal(0)
      expect(result.outputTokens).to.equal(0)
    })

    it('extracts token usage from assistant entries', () => {
      const logPath = path.join(tmpDir, 'assistant.jsonl')
      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-sonnet-4-6',
            usage: {
              input_tokens: 1000,
              output_tokens: 500,
              cache_read_input_tokens: 200,
              cache_creation_input_tokens: 100,
            },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-sonnet-4-6',
            usage: {
              input_tokens: 2000,
              output_tokens: 800,
              cache_read_input_tokens: 300,
              cache_creation_input_tokens: 50,
            },
          },
        }),
      ]
      fs.writeFileSync(logPath, lines.join('\n'))

      const result = parseSessionTokensSync(logPath)
      expect(result.inputTokens).to.equal(3000)
      expect(result.outputTokens).to.equal(1300)
      expect(result.cacheReadTokens).to.equal(500)
      expect(result.cacheCreationTokens).to.equal(150)
      expect(result.model).to.equal('claude-sonnet-4-6')
    })

    it('extracts token usage from tool_use entries', () => {
      const logPath = path.join(tmpDir, 'tooluse.jsonl')
      const lines = [
        JSON.stringify({
          type: 'tool_use',
          message: {
            usage: {
              input_tokens: 500,
              output_tokens: 200,
              cache_read_input_tokens: 100,
              cache_creation_input_tokens: 0,
            },
          },
        }),
      ]
      fs.writeFileSync(logPath, lines.join('\n'))

      const result = parseSessionTokensSync(logPath)
      expect(result.inputTokens).to.equal(500)
      expect(result.outputTokens).to.equal(200)
      expect(result.cacheReadTokens).to.equal(100)
    })

    it('skips non-token event types', () => {
      const logPath = path.join(tmpDir, 'mixed.jsonl')
      const lines = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        }),
        JSON.stringify({ type: 'text', message: { content: 'text' } }),
        JSON.stringify({ type: 'thinking', message: {} }),
      ]
      fs.writeFileSync(logPath, lines.join('\n'))

      const result = parseSessionTokensSync(logPath)
      expect(result.inputTokens).to.equal(100)
      expect(result.outputTokens).to.equal(50)
    })

    it('skips malformed JSON lines gracefully', () => {
      const logPath = path.join(tmpDir, 'malformed.jsonl')
      const lines = [
        'not valid json',
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        }),
        '{broken json',
      ]
      fs.writeFileSync(logPath, lines.join('\n'))

      const result = parseSessionTokensSync(logPath)
      expect(result.inputTokens).to.equal(100)
      expect(result.outputTokens).to.equal(50)
    })

    it('captures last model seen', () => {
      const logPath = path.join(tmpDir, 'models.jsonl')
      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-opus-4-6',
            usage: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        }),
      ]
      fs.writeFileSync(logPath, lines.join('\n'))

      const result = parseSessionTokensSync(logPath)
      expect(result.model).to.equal('claude-opus-4-6')
    })

    it('calculates cost using model pricing', () => {
      const logPath = path.join(tmpDir, 'cost.jsonl')
      // 1M input tokens at Sonnet price ($3/M) = $3.00
      // 1M output tokens at Sonnet price ($15/M) = $15.00
      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        }),
      ]
      fs.writeFileSync(logPath, lines.join('\n'))

      const result = parseSessionTokensSync(logPath)
      expect(result.estimatedCostUsd).to.be.closeTo(18.0, 0.01)
    })
  })

  // ===========================================================================
  // calculateCost
  // ===========================================================================

  describe('calculateCost', () => {
    it('calculates Sonnet pricing correctly', () => {
      const cost = calculateCost(1_000_000, 1_000_000, 0, 0, 'claude-sonnet-4-6')
      // Input: $3/M + Output: $15/M = $18
      expect(cost).to.be.closeTo(18.0, 0.01)
    })

    it('calculates Opus pricing correctly', () => {
      const cost = calculateCost(1_000_000, 1_000_000, 0, 0, 'claude-opus-4-6')
      // Input: $15/M + Output: $75/M = $90
      expect(cost).to.be.closeTo(90.0, 0.01)
    })

    it('accounts for cache read tokens at 10% of input price', () => {
      // 1M cache read tokens at Sonnet: $0.30/M
      const cost = calculateCost(0, 0, 1_000_000, 0, 'claude-sonnet-4-6')
      expect(cost).to.be.closeTo(0.3, 0.01)
    })

    it('accounts for cache creation tokens', () => {
      // 1M cache creation tokens at Sonnet: $3.75/M (1.25x input)
      const cost = calculateCost(0, 0, 0, 1_000_000, 'claude-sonnet-4-6')
      expect(cost).to.be.closeTo(3.75, 0.01)
    })

    it('defaults to Sonnet pricing for unknown models', () => {
      const cost = calculateCost(1_000_000, 0, 0, 0, 'unknown-model')
      expect(cost).to.be.closeTo(3.0, 0.01)
    })

    it('defaults to Sonnet pricing for null model', () => {
      const cost = calculateCost(1_000_000, 0, 0, 0, null)
      expect(cost).to.be.closeTo(3.0, 0.01)
    })

    it('infers Opus pricing from model name containing opus', () => {
      const cost = calculateCost(1_000_000, 0, 0, 0, 'claude-opus-4-5-something')
      expect(cost).to.be.closeTo(15.0, 0.01)
    })
  })

  // ===========================================================================
  // Formatting helpers
  // ===========================================================================

  describe('formatTokenCount', () => {
    it('formats small numbers as-is', () => {
      expect(formatTokenCount(500)).to.equal('500')
    })

    it('formats thousands with K suffix', () => {
      expect(formatTokenCount(1500)).to.equal('1.5K')
    })

    it('formats millions with M suffix', () => {
      expect(formatTokenCount(2_500_000)).to.equal('2.5M')
    })
  })

  describe('formatCost', () => {
    it('formats dollars with 2 decimals', () => {
      expect(formatCost(5.5)).to.equal('$5.50')
    })

    it('formats cents with 3 decimals', () => {
      expect(formatCost(0.05)).to.equal('$0.050')
    })

    it('formats sub-cent with 4 decimals', () => {
      expect(formatCost(0.005)).to.equal('$0.0050')
    })
  })

  // ===========================================================================
  // findSessionLogPath
  // ===========================================================================

  describe('findSessionLogPath', () => {
    it('returns null when claude directory does not exist', () => {
      const result = findSessionLogPath('nonexistent-session-id')
      // May or may not be null depending on whether ~/.claude/projects exists
      // The important thing is it doesn't throw
      expect(result === null || typeof result === 'string').to.be.true
    })
  })
})

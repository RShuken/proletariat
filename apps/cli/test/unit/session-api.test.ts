import { expect } from 'chai'
import { stripAnsi } from '../../src/lib/styles.js'

/**
 * Unit tests for session API helpers used by the REST endpoints.
 *
 * Tests ANSI stripping (used by GET /api/sessions/:name/peek)
 * and URL pattern matching used in route dispatch.
 */
describe('Session API helpers', () => {

  // ===========================================================================
  // stripAnsi — used by peek endpoint to clean tmux output
  // ===========================================================================

  describe('stripAnsi()', () => {
    it('strips color codes from tmux output', () => {
      const raw = '\x1B[32mSuccess\x1B[0m: Build complete'
      expect(stripAnsi(raw)).to.equal('Success: Build complete')
    })

    it('strips bold and underline codes', () => {
      const raw = '\x1B[1mBold\x1B[22m \x1B[4mUnderline\x1B[24m'
      expect(stripAnsi(raw)).to.equal('Bold Underline')
    })

    it('handles text with no ANSI codes', () => {
      expect(stripAnsi('plain text')).to.equal('plain text')
    })

    it('handles empty string', () => {
      expect(stripAnsi('')).to.equal('')
    })

    it('strips multiple consecutive ANSI codes', () => {
      const raw = '\x1B[1m\x1B[36m\x1B[44mcyan on blue\x1B[0m'
      expect(stripAnsi(raw)).to.equal('cyan on blue')
    })
  })

  // ===========================================================================
  // URL pattern matching — mirrors server.ts regex patterns
  // ===========================================================================

  describe('URL route patterns', () => {
    const peekPattern = /^\/api\/sessions\/([^/]+)\/peek(\?.*)?$/
    const sendPattern = /^\/api\/sessions\/([^/]+)\/send$/

    it('matches peek route without query', () => {
      const match = '/api/sessions/my-session/peek'.match(peekPattern)
      expect(match).to.not.be.null
      expect(match![1]).to.equal('my-session')
    })

    it('matches peek route with lines param', () => {
      const match = '/api/sessions/my-session/peek?lines=100'.match(peekPattern)
      expect(match).to.not.be.null
      expect(match![1]).to.equal('my-session')
      expect(match![2]).to.equal('?lines=100')
    })

    it('matches peek route with format param', () => {
      const match = '/api/sessions/user--TKT-1-work-agent/peek?format=text'.match(peekPattern)
      expect(match).to.not.be.null
      expect(match![1]).to.equal('user--TKT-1-work-agent')
    })

    it('matches send route', () => {
      const match = '/api/sessions/my-session/send'.match(sendPattern)
      expect(match).to.not.be.null
      expect(match![1]).to.equal('my-session')
    })

    it('does not match peek route for /api/sessions (no name)', () => {
      expect('/api/sessions//peek'.match(peekPattern)).to.be.null
    })

    it('does not match send route with trailing slash', () => {
      expect('/api/sessions/my-session/send/'.match(sendPattern)).to.be.null
    })

    it('handles encoded session names in peek route', () => {
      const match = '/api/sessions/alice--TKT-42-Implement-cool-agent/peek?lines=20'.match(peekPattern)
      expect(match).to.not.be.null
      expect(match![1]).to.equal('alice--TKT-42-Implement-cool-agent')
    })
  })
})

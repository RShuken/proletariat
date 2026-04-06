import { expect } from 'chai'

import {
  parseSessionName,
  buildExpectedSessionName,
  buildLegacySessionName,
  sessionMatchesExecution,
  findSessionForExecution,
  findContainerSessionsByPrefix,
  getCurrentUser,
  isSessionVisibleToCurrentUser,
  filterSessionsByCurrentUser,
  USER_SESSION_SEPARATOR,
  KNOWN_ACTIONS,
} from '../../src/lib/execution/session-utils.js'

/**
 * Unit tests for session utility functions
 */
describe('Session Utils', () => {
  describe('parseSessionName', () => {
    it('should parse standard legacy session name format', () => {
      const result = parseSessionName('TKT-123-Implement-my-agent')
      expect(result).to.deep.equal({
        user: undefined,
        ticketId: 'TKT-123',
        action: 'Implement',
        agentName: 'my-agent',
      })
    })

    it('should parse user-prefixed session name', () => {
      const result = parseSessionName('alice--TKT-123-Implement-my-agent')
      expect(result).to.deep.equal({
        user: 'alice',
        ticketId: 'TKT-123',
        action: 'Implement',
        agentName: 'my-agent',
      })
    })

    it('should parse session name with hyphenated agent name', () => {
      const result = parseSessionName('TKT-878-Implement-stout-page')
      expect(result).to.deep.equal({
        user: undefined,
        ticketId: 'TKT-878',
        action: 'Implement',
        agentName: 'stout-page',
      })
    })

    it('should parse user-prefixed session with hyphenated agent name', () => {
      const result = parseSessionName('bob--TKT-878-Implement-stout-page')
      expect(result).to.deep.equal({
        user: 'bob',
        ticketId: 'TKT-878',
        action: 'Implement',
        agentName: 'stout-page',
      })
    })

    it('should parse session name with multi-hyphen agent name', () => {
      const result = parseSessionName('TKT-100-Review-very-long-agent-name')
      expect(result).to.deep.equal({
        user: undefined,
        ticketId: 'TKT-100',
        action: 'Review',
        agentName: 'very-long-agent-name',
      })
    })

    it('should handle lowercase action names', () => {
      const result = parseSessionName('TKT-456-work-test-agent')
      expect(result).to.deep.equal({
        user: undefined,
        ticketId: 'TKT-456',
        action: 'work',
        agentName: 'test-agent',
      })
    })

    it('should handle different ticket ID formats', () => {
      const result = parseSessionName('PROJ-999-Fix-buggy-bot')
      expect(result).to.deep.equal({
        user: undefined,
        ticketId: 'PROJ-999',
        action: 'Fix',
        agentName: 'buggy-bot',
      })
    })

    it('should return null for invalid session name (no ticket ID)', () => {
      const result = parseSessionName('invalid-session-name')
      expect(result).to.be.null
    })

    it('should return null for invalid session name (missing components)', () => {
      const result = parseSessionName('TKT-123')
      expect(result).to.be.null
    })

    it('should return null for empty string', () => {
      const result = parseSessionName('')
      expect(result).to.be.null
    })

    it('should handle unknown action names via fallback', () => {
      // Unknown action "CustomAction" should still parse via fallback
      const result = parseSessionName('TKT-123-CustomAction-my-agent')
      expect(result).to.deep.equal({
        user: undefined,
        ticketId: 'TKT-123',
        action: 'CustomAction',
        agentName: 'my-agent',
      })
    })

    // Edge case from PR review: action names with hyphens
    it('should handle hyphenated action when it matches a known action prefix', () => {
      // If action is "Implement" (known), agent is "multi-part-name"
      const result = parseSessionName('TKT-123-Implement-multi-part-name')
      expect(result).to.deep.equal({
        user: undefined,
        ticketId: 'TKT-123',
        action: 'Implement',
        agentName: 'multi-part-name',
      })
    })

    it('should not treat double-dash as user prefix when remainder is not a ticket ID', () => {
      // "foo--bar-baz" — after splitting on --, remainder "bar-baz" doesn't start with TICKET-ID
      const result = parseSessionName('foo--bar-baz')
      expect(result).to.be.null
    })
  })

  describe('buildExpectedSessionName', () => {
    const user = getCurrentUser()

    it('should build user-prefixed session name with default action', () => {
      const result = buildExpectedSessionName('TKT-123', 'my-agent')
      expect(result).to.equal(`${user}--TKT-123-work-my-agent`)
    })

    it('should build user-prefixed session name with custom action', () => {
      const result = buildExpectedSessionName('TKT-456', 'test-agent', 'Implement')
      expect(result).to.equal(`${user}--TKT-456-Implement-test-agent`)
    })

    it('should handle hyphenated agent names', () => {
      const result = buildExpectedSessionName('TKT-789', 'stout-page', 'Review')
      expect(result).to.equal(`${user}--TKT-789-Review-stout-page`)
    })
  })

  describe('buildLegacySessionName', () => {
    it('should build session name without user prefix', () => {
      const result = buildLegacySessionName('TKT-123', 'my-agent')
      expect(result).to.equal('TKT-123-work-my-agent')
    })

    it('should build session name with custom action', () => {
      const result = buildLegacySessionName('TKT-456', 'test-agent', 'Implement')
      expect(result).to.equal('TKT-456-Implement-test-agent')
    })
  })

  describe('sessionMatchesExecution', () => {
    it('should match when ticket ID and agent name match', () => {
      const result = sessionMatchesExecution(
        'TKT-123-Implement-my-agent',
        'TKT-123',
        'my-agent'
      )
      expect(result).to.be.true
    })

    it('should match with hyphenated agent name', () => {
      const result = sessionMatchesExecution(
        'TKT-878-Implement-stout-page',
        'TKT-878',
        'stout-page'
      )
      expect(result).to.be.true
    })

    it('should NOT match when ticket ID differs', () => {
      const result = sessionMatchesExecution(
        'TKT-999-Implement-my-agent',
        'TKT-123',
        'my-agent'
      )
      expect(result).to.be.false
    })

    it('should NOT match when agent name differs', () => {
      const result = sessionMatchesExecution(
        'TKT-123-Implement-other-agent',
        'TKT-123',
        'my-agent'
      )
      expect(result).to.be.false
    })

    // Key bug fix: prevent matching wrong agent on same ticket
    it('should NOT match different agent on same ticket', () => {
      // Two agents working on same ticket: agent1 and agent2
      // Session for agent1 should NOT match agent2
      const result = sessionMatchesExecution(
        'TKT-878-Implement-agent1',
        'TKT-878',
        'agent2'
      )
      expect(result).to.be.false
    })

    it('should NOT match when agent name is a substring', () => {
      // "page" is a suffix of "stout-page" but they're different agents
      const result = sessionMatchesExecution(
        'TKT-123-Implement-stout-page',
        'TKT-123',
        'page'
      )
      expect(result).to.be.false
    })
  })

  describe('findSessionForExecution', () => {
    const user = getCurrentUser()

    // Legacy (unprefixed) sessions
    const legacySessions = [
      'TKT-123-Implement-agent1',
      'TKT-123-Review-agent2',
      'TKT-456-work-my-agent',
      'TKT-789-Fix-buggy-bot',
    ]

    it('should find legacy exact match with known action', () => {
      const result = findSessionForExecution('TKT-123', 'agent1', legacySessions)
      expect(result).to.equal('TKT-123-Implement-agent1')
    })

    it('should find legacy exact match with different action', () => {
      const result = findSessionForExecution('TKT-123', 'agent2', legacySessions)
      expect(result).to.equal('TKT-123-Review-agent2')
    })

    it('should find legacy session with default work action', () => {
      const result = findSessionForExecution('TKT-456', 'my-agent', legacySessions)
      expect(result).to.equal('TKT-456-work-my-agent')
    })

    it('should find user-prefixed session', () => {
      const sessions = [`${user}--TKT-123-Implement-agent1`]
      const result = findSessionForExecution('TKT-123', 'agent1', sessions)
      expect(result).to.equal(`${user}--TKT-123-Implement-agent1`)
    })

    it('should prefer user-prefixed session over legacy', () => {
      const sessions = [
        'TKT-123-Implement-agent1',             // legacy
        `${user}--TKT-123-Implement-agent1`,     // prefixed
      ]
      const result = findSessionForExecution('TKT-123', 'agent1', sessions)
      // Prefixed is tried first, should be returned
      expect(result).to.equal(`${user}--TKT-123-Implement-agent1`)
    })

    it('should return null when no match found', () => {
      const result = findSessionForExecution('TKT-999', 'nonexistent', legacySessions)
      expect(result).to.be.null
    })

    it('should NOT match wrong agent on same ticket', () => {
      const result = findSessionForExecution('TKT-123', 'agent3', legacySessions)
      expect(result).to.be.null
    })

    it('should handle empty available sessions', () => {
      const result = findSessionForExecution('TKT-123', 'agent1', [])
      expect(result).to.be.null
    })

    it('should find session with case-insensitive action match', () => {
      const sessions = ['TKT-100-implement-my-agent']
      const result = findSessionForExecution('TKT-100', 'my-agent', sessions)
      expect(result).to.equal('TKT-100-implement-my-agent')
    })

    it('should prefer exact known action match over partial match', () => {
      const sessions = [
        'TKT-123-Custom-agent',
        'TKT-123-Implement-agent',
      ]
      const result = findSessionForExecution('TKT-123', 'agent', sessions)
      expect(result).to.equal('TKT-123-Implement-agent')
    })
  })

  describe('findContainerSessionsByPrefix', () => {
    const sessionMap = new Map<string, string[]>([
      ['977b5fc9f60d', ['TKT-1087-Implement-pure-pichai']],
      ['abcdef123456', ['TKT-1005-Groom-witty-rabois']],
    ])

    it('should return exact match when container ID exists', () => {
      const result = findContainerSessionsByPrefix(sessionMap, '977b5fc9f60d')
      expect(result).to.deep.equal(['TKT-1087-Implement-pure-pichai'])
    })

    it('should match when DB has short ID and map has longer prefix', () => {
      const longMap = new Map<string, string[]>([
        ['977b5fc9f60d1234', ['TKT-1087-Implement-pure-pichai']],
      ])
      const result = findContainerSessionsByPrefix(longMap, '977b5fc9f60d')
      expect(result).to.deep.equal(['TKT-1087-Implement-pure-pichai'])
    })

    it('should match when DB has longer ID and map has short ID', () => {
      const result = findContainerSessionsByPrefix(sessionMap, '977b5fc9f60d1234')
      expect(result).to.deep.equal(['TKT-1087-Implement-pure-pichai'])
    })

    it('should return empty array when no matching container exists', () => {
      const result = findContainerSessionsByPrefix(sessionMap, 'doesnotexist')
      expect(result).to.deep.equal([])
    })
  })

  describe('KNOWN_ACTIONS', () => {
    it('should include common action names', () => {
      expect(KNOWN_ACTIONS).to.include('Implement')
      expect(KNOWN_ACTIONS).to.include('Review')
      expect(KNOWN_ACTIONS).to.include('Fix')
      expect(KNOWN_ACTIONS).to.include('work')
    })

    it('should be a readonly array', () => {
      // TypeScript enforces this, but we can verify the values exist
      expect(KNOWN_ACTIONS.length).to.be.greaterThan(0)
    })
  })

  describe('Edge Cases', () => {
    describe('multiple agents on same ticket', () => {
      it('should correctly identify each agent session', () => {
        const sessions = [
          'TKT-878-Implement-stout-page',
          'TKT-878-Review-altman',
          'TKT-878-Fix-bezos',
        ]

        // Each agent should find their own session
        expect(findSessionForExecution('TKT-878', 'stout-page', sessions))
          .to.equal('TKT-878-Implement-stout-page')

        expect(findSessionForExecution('TKT-878', 'altman', sessions))
          .to.equal('TKT-878-Review-altman')

        expect(findSessionForExecution('TKT-878', 'bezos', sessions))
          .to.equal('TKT-878-Fix-bezos')
      })

      it('should NOT cross-match agents', () => {
        const sessions = [
          'TKT-878-Implement-stout-page',
          'TKT-878-Review-altman',
        ]

        // Looking for a different agent should return null
        expect(findSessionForExecution('TKT-878', 'gates', sessions))
          .to.be.null
      })
    })

    describe('session name parsing edge cases', () => {
      it('should handle ticket IDs with large numbers', () => {
        const result = parseSessionName('TKT-99999-Implement-agent')
        expect(result?.ticketId).to.equal('TKT-99999')
      })

      it('should handle single-character agent names', () => {
        const result = parseSessionName('TKT-1-work-a')
        expect(result).to.deep.equal({
          user: undefined,
          ticketId: 'TKT-1',
          action: 'work',
          agentName: 'a',
        })
      })

      it('should handle agent names with numbers', () => {
        const result = parseSessionName('TKT-123-Implement-agent42')
        expect(result).to.deep.equal({
          user: undefined,
          ticketId: 'TKT-123',
          action: 'Implement',
          agentName: 'agent42',
        })
      })
    })
  })

  // ===========================================================================
  // TKT-012: User-scoped session tests
  // ===========================================================================

  describe('getCurrentUser', () => {
    it('should return a non-empty string', () => {
      const user = getCurrentUser()
      expect(user).to.be.a('string')
      expect(user.length).to.be.greaterThan(0)
    })

    it('should respect PRLT_USER env var', () => {
      const original = process.env.PRLT_USER
      try {
        process.env.PRLT_USER = 'test-override'
        expect(getCurrentUser()).to.equal('test-override')
      } finally {
        if (original === undefined) {
          delete process.env.PRLT_USER
        } else {
          process.env.PRLT_USER = original
        }
      }
    })
  })

  describe('isSessionVisibleToCurrentUser', () => {
    const user = getCurrentUser()

    it('should show legacy (unprefixed) sessions to everyone', () => {
      expect(isSessionVisibleToCurrentUser('TKT-123-Implement-agent')).to.be.true
    })

    it('should show sessions prefixed with current user', () => {
      expect(isSessionVisibleToCurrentUser(`${user}--TKT-123-Implement-agent`)).to.be.true
    })

    it('should hide sessions prefixed with a different user', () => {
      expect(isSessionVisibleToCurrentUser('otheruser--TKT-123-Implement-agent')).to.be.false
    })

    it('should show unparseable session names to everyone', () => {
      expect(isSessionVisibleToCurrentUser('random-session')).to.be.true
    })
  })

  describe('filterSessionsByCurrentUser', () => {
    const user = getCurrentUser()

    it('should keep legacy and own sessions, filter out other users', () => {
      const sessions = [
        'TKT-1-work-agent1',                   // legacy
        `${user}--TKT-2-work-agent2`,           // own
        'otheruser--TKT-3-work-agent3',          // other
        'random-name',                            // unparseable
      ]
      const filtered = filterSessionsByCurrentUser(sessions)
      expect(filtered).to.deep.equal([
        'TKT-1-work-agent1',
        `${user}--TKT-2-work-agent2`,
        'random-name',
      ])
    })

    it('should return empty array for empty input', () => {
      expect(filterSessionsByCurrentUser([])).to.deep.equal([])
    })
  })

  describe('USER_SESSION_SEPARATOR', () => {
    it('should be double-dash', () => {
      expect(USER_SESSION_SEPARATOR).to.equal('--')
    })
  })
})

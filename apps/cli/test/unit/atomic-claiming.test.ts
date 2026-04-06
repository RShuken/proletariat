import { expect } from 'chai'
import { buildClaimingApiSection } from '../../src/lib/execution/runners/prompt-builder.js'

/**
 * Unit tests for atomic task claiming.
 *
 * Tests the prompt builder section and CAS logic contracts.
 * Storage-level CAS tests are in the e2e suite since they need a real SQLite DB.
 */
describe('Atomic Claiming', () => {

  // ===========================================================================
  // Prompt builder section
  // ===========================================================================

  describe('buildClaimingApiSection()', () => {
    it('returns empty string when no dashboard port is provided', () => {
      const result = buildClaimingApiSection()
      expect(result).to.equal('')
    })

    it('returns empty string when dashboard port is undefined', () => {
      const result = buildClaimingApiSection(undefined)
      expect(result).to.equal('')
    })

    it('includes the correct base URL for the given port', () => {
      const result = buildClaimingApiSection(3000)
      expect(result).to.include('http://localhost:3000')
    })

    it('documents all three endpoints', () => {
      const result = buildClaimingApiSection(8080)
      expect(result).to.include('/api/board/available')
      expect(result).to.include('/api/board/<ticketId>/claim')
      expect(result).to.include('/api/board/<ticketId>/release')
    })

    it('includes CAS / atomicity explanation', () => {
      const result = buildClaimingApiSection(3000)
      expect(result).to.include('Compare-And-Swap')
    })

    it('documents HTTP methods and status codes', () => {
      const result = buildClaimingApiSection(3000)
      expect(result).to.include('POST')
      expect(result).to.include('200')
      expect(result).to.include('409')
    })

    it('includes agent_name in request examples', () => {
      const result = buildClaimingApiSection(3000)
      expect(result).to.include('agent_name')
    })
  })
})

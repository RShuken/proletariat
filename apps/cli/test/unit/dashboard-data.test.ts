import { expect } from 'chai'
import { gatherTmuxPeeks, gatherBoardData, type DashboardSession, type TmuxPeek } from '../../src/lib/dashboard/data.js'

/**
 * Unit tests for dashboard data aggregation.
 *
 * Tests the pure data-transformation functions that don't require
 * a live workspace, tmux server, or database connection.
 */
describe('Dashboard Data', () => {

  // ===========================================================================
  // gatherTmuxPeeks
  // ===========================================================================

  describe('gatherTmuxPeeks()', () => {
    it('returns empty array for empty sessions list', () => {
      const result = gatherTmuxPeeks([])
      expect(result).to.deep.equal([])
    })

    it('skips sessions with non-running status', () => {
      const sessions: DashboardSession[] = [
        { sessionId: 's1', ticketId: 'TKT-1', agentName: 'agent-a', status: 'orphan', environment: 'host', source: 'discovered' },
        { sessionId: 's2', ticketId: 'TKT-2', agentName: 'agent-b', status: 'completed', environment: 'host', source: 'db' },
      ]
      // These should be skipped because status is not 'running' or 'starting'
      // captureTmuxPane will not be called, so no error even without tmux
      const result = gatherTmuxPeeks(sessions)
      expect(result).to.deep.equal([])
    })

    it('gracefully handles tmux capture failures for running sessions', () => {
      // Running sessions will attempt tmux capture, which will fail in test env
      // The function should catch the error and return empty
      const sessions: DashboardSession[] = [
        { sessionId: 'nonexistent-session', ticketId: 'TKT-1', agentName: 'agent-a', status: 'running', environment: 'host', source: 'db' },
      ]
      const result = gatherTmuxPeeks(sessions)
      // Either empty (tmux not available) or has data (if tmux happens to be running)
      expect(result).to.be.an('array')
    })
  })

  // ===========================================================================
  // gatherBoardData
  // ===========================================================================

  describe('gatherBoardData()', () => {
    it('returns empty columns when board has no columns', async () => {
      const mockStorage = {
        getBoard: async () => ({
          id: 'board-1',
          projectId: 'proj-1',
          columns: [],
        }),
      }

      const result = await gatherBoardData(mockStorage as any, 'proj-1')
      expect(result.columns).to.deep.equal([])
    })

    it('maps board columns and tickets correctly', async () => {
      const mockStorage = {
        getBoard: async () => ({
          id: 'board-1',
          projectId: 'proj-1',
          columns: [
            {
              id: 'col-1',
              name: 'Backlog',
              position: 0,
              tickets: [
                { id: 'TKT-001', title: 'Task A', priority: 'P1', category: 'feature', labels: ['api'] },
                { id: 'TKT-002', title: 'Task B', priority: 'P2', labels: [] },
              ],
            },
            {
              id: 'col-2',
              name: 'In Progress',
              position: 1,
              tickets: [],
            },
          ],
        }),
      }

      const result = await gatherBoardData(mockStorage as any, 'proj-1')
      expect(result.columns).to.have.length(2)
      expect(result.columns[0].name).to.equal('Backlog')
      expect(result.columns[0].tickets).to.have.length(2)
      expect(result.columns[0].tickets[0].id).to.equal('TKT-001')
      expect(result.columns[0].tickets[0].priority).to.equal('P1')
      expect(result.columns[0].tickets[0].labels).to.deep.equal(['api'])
      expect(result.columns[1].name).to.equal('In Progress')
      expect(result.columns[1].tickets).to.have.length(0)
    })

    it('handles storage errors gracefully', async () => {
      const mockStorage = {
        getBoard: async () => { throw new Error('DB offline') },
      }

      const result = await gatherBoardData(mockStorage as any, 'proj-1')
      expect(result.columns).to.deep.equal([])
    })
  })
})

import { expect } from 'chai'
import { getDashboardHTML } from '../../src/lib/dashboard/html.js'

/**
 * Unit tests for the dashboard HTML template.
 * Verifies structural requirements: WebSocket connection, mobile responsive
 * classes, agent status cards, token usage display, tmux peek section,
 * and ticket board rendering.
 */
describe('Dashboard HTML', () => {
  const html = getDashboardHTML(3000)

  it('returns valid HTML document', () => {
    expect(html).to.include('<!DOCTYPE html>')
    expect(html).to.include('</html>')
  })

  it('uses WebSocket instead of SSE for live updates', () => {
    expect(html).to.include('WebSocket')
    expect(html).to.include('ws://localhost:3000')
    expect(html).to.include('connectWebSocket')
    expect(html).not.to.include('EventSource')
    expect(html).not.to.include('/api/events')
  })

  it('includes agent status rendering with derived status', () => {
    expect(html).to.include('renderAgents')
    expect(html).to.include('derivedStatus')
    expect(html).to.include('statusConfig')
    expect(html).to.include("'working'")
    expect(html).to.include("'idle'")
    expect(html).to.include("'needs-input'")
    expect(html).to.include("'error'")
  })

  it('includes elapsed time formatting', () => {
    expect(html).to.include('formatElapsed')
    expect(html).to.include('elapsedSeconds')
  })

  it('includes token usage display', () => {
    expect(html).to.include('tokenUsage')
    expect(html).to.include('formatTokens')
    expect(html).to.include('formatCost')
    expect(html).to.include('estimatedCostUsd')
    expect(html).to.include('inputTokens')
    expect(html).to.include('outputTokens')
    expect(html).to.include('cacheReadTokens')
  })

  it('includes tmux peek section', () => {
    expect(html).to.include('peek-section')
    expect(html).to.include('peek-grid')
    expect(html).to.include('renderPeeks')
    expect(html).to.include('tmuxPeeks')
    expect(html).to.include('tmux-peek')
    expect(html).to.include('Live Output')
  })

  it('includes ticket board with kanban view', () => {
    expect(html).to.include('kanban')
    expect(html).to.include('renderBoard')
    expect(html).to.include('Board')
  })

  it('is mobile responsive with CSS media queries', () => {
    expect(html).to.include('@media (max-width: 640px)')
    expect(html).to.include('kanban-scroll')
    expect(html).to.include('agent-grid')
    expect(html).to.include('peek-grid')
    expect(html).to.include('session-table')
  })

  it('uses the correct port in WebSocket URL', () => {
    const html8080 = getDashboardHTML(8080)
    expect(html8080).to.include('ws://localhost:8080')
    expect(html8080).not.to.include('ws://localhost:3000')
  })

  it('includes XSS protection via esc() helper', () => {
    expect(html).to.include('function esc(str)')
    expect(html).to.include('textContent')
  })

  it('includes reconnection logic with backoff', () => {
    expect(html).to.include('reconnectDelay')
    expect(html).to.include('Math.min')
  })

  it('uses initial HTTP fetch for fast first paint', () => {
    expect(html).to.include("fetch('/api/data')")
  })
})

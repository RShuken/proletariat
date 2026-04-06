import { expect } from 'chai'
import {
  formatDuration,
  padEnd,
  truncate,
  renderDashboard,
  type AgentSnapshot,
} from '../../src/commands/monitor.js'

describe('Monitor command helpers', () => {
  describe('formatDuration', () => {
    it('formats seconds', () => {
      expect(formatDuration(0)).to.equal('0s')
      expect(formatDuration(5000)).to.equal('5s')
      expect(formatDuration(59000)).to.equal('59s')
    })

    it('formats minutes and seconds', () => {
      expect(formatDuration(60000)).to.equal('1m 0s')
      expect(formatDuration(90000)).to.equal('1m 30s')
      expect(formatDuration(3599000)).to.equal('59m 59s')
    })

    it('formats hours and minutes', () => {
      expect(formatDuration(3600000)).to.equal('1h 0m')
      expect(formatDuration(5400000)).to.equal('1h 30m')
      expect(formatDuration(86399000)).to.equal('23h 59m')
    })

    it('formats days and hours', () => {
      expect(formatDuration(86400000)).to.equal('1d 0h')
      expect(formatDuration(90000000)).to.equal('1d 1h')
      expect(formatDuration(172800000)).to.equal('2d 0h')
    })
  })

  describe('padEnd', () => {
    it('pads short strings', () => {
      expect(padEnd('hi', 5)).to.equal('hi   ')
    })

    it('truncates long strings', () => {
      expect(padEnd('hello world', 5)).to.equal('hello')
    })

    it('returns exact length strings unchanged', () => {
      expect(padEnd('exact', 5)).to.equal('exact')
    })
  })

  describe('truncate', () => {
    it('returns short strings unchanged', () => {
      expect(truncate('hello', 10)).to.equal('hello')
    })

    it('truncates long strings with ellipsis', () => {
      expect(truncate('hello world!', 8)).to.equal('hello...')
    })

    it('handles exact length', () => {
      expect(truncate('hello', 5)).to.equal('hello')
    })
  })

  describe('renderDashboard', () => {
    it('renders empty state when no agents', () => {
      const output = renderDashboard([])
      expect(output).to.include('No running agents')
      expect(output).to.include('prlt run')
    })

    it('renders agent info with ticket ID and uptime', () => {
      const snapshots: AgentSnapshot[] = [{
        agentName: 'brave-fox',
        ticketId: 'TKT-123',
        runner: 'claude',
        task: 'Implement feature X',
        environment: 'host',
        status: 'running',
        uptime: '5m 30s',
        uptimeMs: 330000,
        lastOutput: ['Building...', 'Tests passed'],
        gitStatus: { branch: 'feat/feature-x', uncommitted: 2 },
        sessionName: 'user--TKT-123-work-brave-fox',
        workdir: '/tmp/test',
      }]

      const output = renderDashboard(snapshots)
      expect(output).to.include('TKT-123')
      expect(output).to.include('brave-fox')
      expect(output).to.include('claude')
      expect(output).to.include('5m 30s')
      expect(output).to.include('feat/feature-x')
      expect(output).to.include('2 uncommitted')
      expect(output).to.include('Implement feature X')
      expect(output).to.include('Building...')
      expect(output).to.include('Tests passed')
    })

    it('renders clean git status', () => {
      const snapshots: AgentSnapshot[] = [{
        agentName: 'quiet-owl',
        ticketId: 'TKT-456',
        runner: 'codex',
        task: 'Fix bug',
        environment: 'docker',
        status: 'running',
        uptime: '1h 0m',
        uptimeMs: 3600000,
        lastOutput: [],
        gitStatus: { branch: 'main', uncommitted: 0 },
        sessionName: 'user--TKT-456-work-quiet-owl',
        workdir: '/tmp/test2',
      }]

      const output = renderDashboard(snapshots)
      expect(output).to.include('[clean]')
      expect(output).to.include('no recent output')
    })

    it('renders multiple agents with separators', () => {
      const snapshots: AgentSnapshot[] = [
        {
          agentName: 'agent-a',
          ticketId: 'TKT-1',
          runner: 'claude',
          task: 'Task A',
          environment: 'host',
          status: 'running',
          uptime: '2m 0s',
          uptimeMs: 120000,
          lastOutput: ['line1'],
          gitStatus: null,
          sessionName: 'user--TKT-1-work-agent-a',
          workdir: '/tmp/a',
        },
        {
          agentName: 'agent-b',
          ticketId: 'TKT-2',
          runner: 'claude',
          task: 'Task B',
          environment: 'host',
          status: 'running',
          uptime: '3m 0s',
          uptimeMs: 180000,
          lastOutput: ['line2'],
          gitStatus: null,
          sessionName: 'user--TKT-2-work-agent-b',
          workdir: '/tmp/b',
        },
      ]

      const output = renderDashboard(snapshots)
      expect(output).to.include('agent-a')
      expect(output).to.include('agent-b')
      expect(output).to.include('2 agents running')
      // Should have thin separator between agents
      expect(output).to.include('─')
    })

    it('renders singular agent count', () => {
      const snapshots: AgentSnapshot[] = [{
        agentName: 'solo',
        ticketId: undefined,
        runner: 'claude',
        task: 'Solo task',
        environment: 'host',
        status: 'running',
        uptime: '10s',
        uptimeMs: 10000,
        lastOutput: [],
        gitStatus: null,
        sessionName: 'solo-session',
        workdir: '/tmp/solo',
      }]

      const output = renderDashboard(snapshots)
      expect(output).to.include('1 agent running')
      // Should NOT have 's' after 'agent'
      expect(output).to.not.include('1 agents')
    })
  })
})

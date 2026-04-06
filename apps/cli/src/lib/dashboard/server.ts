/**
 * Dashboard HTTP + WebSocket Server
 *
 * Serves the dashboard HTML, JSON API, and WebSocket live updates.
 * WebSocket pushes agent status, board, and tmux peek data every 3 seconds.
 */

import * as http from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { getDashboardHTML } from './html.js'
import { gatherDashboardData, gatherSessionData, type DashboardSession } from './data.js'
import { captureTmuxPane, sendTmuxMessage } from '../execution/session-utils.js'
import { stripAnsi } from '../styles.js'
import type { PMOStorage } from '../pmo/types.js'

const WS_BROADCAST_INTERVAL_MS = 3_000

export interface DashboardServerOptions {
  port: number
  storage: PMOStorage
  projectId: string
  projectName: string
}

export interface DashboardServer {
  server: http.Server
  url: string
  close: () => Promise<void>
}

export function createDashboardServer(options: DashboardServerOptions): Promise<DashboardServer> {
  const { port, storage, projectId, projectName } = options
  let broadcastInterval: ReturnType<typeof setInterval> | null = null

  const html = getDashboardHTML(port)
  const sseClients = new Set<http.ServerResponse>()

  const server = http.createServer(async (req, res) => {
    const url = req.url || '/'

    // CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*')

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    if (url === '/api/data') {
      try {
        const data = await gatherDashboardData(storage, projectId, projectName)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data))
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Failed to gather data' }))
      }
      return
    }

    if (url === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      // Send initial data
      try {
        const data = await gatherDashboardData(storage, projectId, projectName)
        res.write(`data: ${JSON.stringify(data)}\n\n`)
      } catch {
        // Will retry on next interval
      }

      sseClients.add(res)

      req.on('close', () => {
        sseClients.delete(res)
      })

      return
    }

    // POST /api/claim-task — atomic task claiming for agents
    if (url === '/api/claim-task' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', async () => {
        try {
          const { agent_name, ticket_id, status_filter } = JSON.parse(body)
          if (!agent_name) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'agent_name is required' }))
            return
          }

          // If a specific ticket is requested, claim it atomically
          if (ticket_id) {
            const ticket = await storage.getTicket(ticket_id)
            if (!ticket) {
              res.writeHead(404, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, error: `Ticket not found: ${ticket_id}` }))
              return
            }
            if (ticket.assignee && ticket.assignee !== agent_name) {
              res.writeHead(409, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({
                success: false,
                error: `Ticket already claimed by ${ticket.assignee}`,
                claimed_by: ticket.assignee,
              }))
              return
            }
            const updated = await storage.updateTicket(ticket_id, { assignee: agent_name })
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              success: true,
              ticket: { id: updated.id, title: updated.title, assignee: updated.assignee },
            }))
            return
          }

          // No specific ticket — claim the next available unassigned ticket
          const filter = status_filter || 'ready'
          const tickets = await storage.listTickets(projectId)
          const available = tickets.find(
            (t) => (!t.assignee) && t.statusCategory === filter
          )

          if (!available) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, ticket: null, message: 'No unassigned tickets available' }))
            return
          }

          const claimed = await storage.updateTicket(available.id, { assignee: agent_name })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            success: true,
            ticket: { id: claimed.id, title: claimed.title, assignee: claimed.assignee },
          }))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'Internal error' }))
        }
      })
      return
    }

    // POST /api/board/:ticketId/claim — atomic CAS claiming
    const claimMatch = url.match(/^\/api\/board\/([^/]+)\/claim$/)
    if (claimMatch && req.method === 'POST') {
      const ticketId = decodeURIComponent(claimMatch[1])
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', async () => {
        try {
          const { agent_name } = JSON.parse(body)
          if (!agent_name) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'agent_name is required' }))
            return
          }
          const result = await storage.claimTicket(ticketId, agent_name)
          if (!result.ticket) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: `Ticket not found: ${ticketId}` }))
            return
          }
          if (!result.claimed) {
            res.writeHead(409, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              success: false,
              error: `Ticket already claimed by ${result.claimedBy}`,
              claimed_by: result.claimedBy,
            }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            success: true,
            ticket: { id: result.ticket.id, title: result.ticket.title, assignee: result.ticket.assignee, priority: result.ticket.priority, statusCategory: result.ticket.statusCategory },
          }))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'Internal error' }))
        }
      })
      return
    }

    // GET /api/board/available — list unassigned tickets ready for work
    if (url.startsWith('/api/board/available') && req.method === 'GET') {
      try {
        const tickets = await storage.listTickets(projectId, { statusCategory: 'unstarted' })
        const available = tickets
          .filter((t) => !t.assignee)
          .sort((a, b) => {
            // Sort by priority: P0 > P1 > P2 > P3 > null
            const pa = a.priority || 'P9'
            const pb = b.priority || 'P9'
            return pa.localeCompare(pb)
          })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          success: true,
          tickets: available.map((t) => ({
            id: t.id, title: t.title, priority: t.priority, category: t.category,
            statusCategory: t.statusCategory, statusName: t.statusName,
          })),
        }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'Internal error' }))
      }
      return
    }

    // =====================================================================
    // Session API routes
    // =====================================================================

    // GET /api/sessions — list all running sessions with status
    if (url === '/api/sessions' && req.method === 'GET') {
      try {
        const sessions = gatherSessionData()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ sessions }))
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Failed to gather session data' }))
      }
      return
    }

    // POST /api/board/:ticketId/release — release a claim
    const releaseMatch = url.match(/^\/api\/board\/([^/]+)\/release$/)
    if (releaseMatch && req.method === 'POST') {
      const ticketId = decodeURIComponent(releaseMatch[1])
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', async () => {
        try {
          const { agent_name } = JSON.parse(body)
          if (!agent_name) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'agent_name is required' }))
            return
          }
          const result = await storage.releaseTicket(ticketId, agent_name)
          if (!result.ticket) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: `Ticket not found: ${ticketId}` }))
            return
          }
          if (!result.released) {
            res.writeHead(409, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              success: false,
              error: `Cannot release: ticket is assigned to ${result.ticket.assignee || 'nobody'}`,
              claimed_by: result.ticket.assignee,
            }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            success: true,
            ticket: { id: result.ticket.id, title: result.ticket.title, assignee: result.ticket.assignee },
          }))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'Internal error' }))
        }
      })
      return
    }

    // GET /api/sessions/:name/peek?lines=50 — capture last N lines from tmux pane
    const peekMatch = url.match(/^\/api\/sessions\/([^/]+)\/peek(\?.*)?$/)
    if (peekMatch && req.method === 'GET') {
      const sessionName = decodeURIComponent(peekMatch[1])
      const params = new URLSearchParams(peekMatch[2]?.slice(1) || '')
      const lines = Math.min(Math.max(parseInt(params.get('lines') || '50', 10) || 50, 1), 500)
      const format = params.get('format') || 'json'

      // Find the session to determine if it's container-based
      let sessions: DashboardSession[]
      try {
        sessions = gatherSessionData()
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Failed to gather session data' }))
        return
      }

      const session = sessions.find(s => s.sessionId === sessionName)
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Session not found: ${sessionName}` }))
        return
      }

      const raw = captureTmuxPane(session.sessionId, lines, session.containerId)
      if (raw === null) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Failed to capture tmux pane' }))
        return
      }

      const cleaned = stripAnsi(raw)
      const linesArray = cleaned.split('\n').slice(-lines)

      if (format === 'text') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(linesArray.join('\n'))
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          sessionId: session.sessionId,
          agentName: session.agentName,
          lines: linesArray,
        }))
      }
      return
    }

    // POST /api/sessions/:name/send — send text to tmux session
    const sendMatch = url.match(/^\/api\/sessions\/([^/]+)\/send$/)
    if (sendMatch && req.method === 'POST') {
      const sessionName = decodeURIComponent(sendMatch[1])

      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        try {
          const { text } = JSON.parse(body)
          if (typeof text !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'text field is required and must be a string' }))
            return
          }

          let sessions: DashboardSession[]
          try {
            sessions = gatherSessionData()
          } catch {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Failed to gather session data' }))
            return
          }

          const session = sessions.find(s => s.sessionId === sessionName)
          if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: `Session not found: ${sessionName}` }))
            return
          }

          sendTmuxMessage(session.sessionId, text, session.containerId)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, sessionId: session.sessionId }))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }))
        }
      })
      return
    }

    // Handle CORS preflight for POST endpoints
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.writeHead(204)
      res.end()
      return
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  })

  // WebSocket server attached to the HTTP server
  const wss = new WebSocketServer({ server })

  // Prevent unhandled WSS errors (e.g. during port conflict)
  wss.on('error', () => { /* handled by server 'error' event */ })

  wss.on('connection', async (ws: WebSocket) => {
    // Send initial data immediately on connect
    try {
      const data = await gatherDashboardData(storage, projectId, projectName)
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(data))
      }
    } catch {
      // Will get data on next broadcast cycle
    }
  })

  // Broadcast to all connected WebSocket clients every 3 seconds
  broadcastInterval = setInterval(async () => {
    if (wss.clients.size === 0) return

    try {
      const data = await gatherDashboardData(storage, projectId, projectName)
      const payload = JSON.stringify(data)
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) {
          try {
            client.send(payload)
          } catch {
            // client disconnected mid-send
          }
        }
      }
    } catch {
      // Data gathering failed, skip this cycle
    }
  }, WS_BROADCAST_INTERVAL_MS)

  const url = `http://localhost:${port}`

  return new Promise<DashboardServer>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      // Clean up WSS on server error to prevent uncaught exceptions
      wss.close()
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Try --port <number> to use a different port.`))
      } else {
        reject(err)
      }
    })

    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        url,
        close: () => {
          return new Promise<void>((resolveClose) => {
            if (broadcastInterval) clearInterval(broadcastInterval)

            // Close all WebSocket connections
            for (const client of wss.clients) {
              try { client.close() } catch { /* client may have already disconnected */ }
            }

            wss.close(() => {
              server.close(() => resolveClose())
            })
          })
        },
      })
    })
  })
}

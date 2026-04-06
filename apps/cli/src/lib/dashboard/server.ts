/**
 * Dashboard HTTP Server
 *
 * Serves the dashboard HTML, JSON API, and SSE events.
 * Zero external dependencies — uses Node.js built-in http module.
 */

import * as http from 'node:http'
import { getDashboardHTML } from './html.js'
import { gatherDashboardData } from './data.js'
import type { PMOStorage } from '../pmo/types.js'

const SSE_INTERVAL_MS = 4_000

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
  const sseClients = new Set<http.ServerResponse>()
  let sseInterval: ReturnType<typeof setInterval> | null = null

  const html = getDashboardHTML(port)

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
      } catch (err) {
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

  // Start SSE broadcast interval
  sseInterval = setInterval(async () => {
    if (sseClients.size === 0) return

    try {
      const data = await gatherDashboardData(storage, projectId, projectName)
      const payload = `data: ${JSON.stringify(data)}\n\n`
      for (const client of sseClients) {
        try {
          client.write(payload)
        } catch {
          sseClients.delete(client)
        }
      }
    } catch {
      // Data gathering failed, skip this cycle
    }
  }, SSE_INTERVAL_MS)

  const url = `http://localhost:${port}`

  return new Promise<DashboardServer>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
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
            if (sseInterval) clearInterval(sseInterval)

            // Close all SSE connections
            for (const client of sseClients) {
              try { client.end() } catch { /* client may have already disconnected — safe to ignore */ }
            }
            sseClients.clear()

            server.close(() => resolveClose())
          })
        },
      })
    })
  })
}

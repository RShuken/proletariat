/**
 * Dashboard HTTP + WebSocket Server
 *
 * Serves the dashboard HTML, JSON API, and WebSocket live updates.
 * WebSocket pushes agent status, board, and tmux peek data every 3 seconds.
 */

import * as http from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { getDashboardHTML } from './html.js'
import { gatherDashboardData } from './data.js'
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

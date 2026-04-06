import { expect } from 'chai'
import * as http from 'node:http'
import WebSocket from 'ws'
import { createDashboardServer, type DashboardServer } from '../../src/lib/dashboard/server.js'

/**
 * Tests for the dashboard HTTP + WebSocket server.
 *
 * Tests focus on server mechanics (routing, content-types, CORS, WebSocket setup,
 * port conflict, shutdown). Data-gathering routes are tested with a mock
 * storage that resolves instantly, but gatherAgentData/gatherSessionData/
 * gatherPRData call real system commands (gh, tmux) that may timeout.
 * To keep tests fast, we only assert on routes that don't depend on those.
 */
describe('Dashboard Server', function (this: Mocha.Suite) {
  this.timeout(15_000)

  let dashboard: DashboardServer | null = null

  // Use a random high port to avoid conflicts
  const TEST_PORT = 49152 + Math.floor(Math.random() * 10000)

  // Minimal mock PMOStorage
  const mockStorage = {
    getBoard: async () => ({
      id: 'board-1',
      projectId: 'proj-1',
      columns: [],
    }),
  }

  afterEach(async () => {
    if (dashboard) {
      await dashboard.close()
      dashboard = null
    }
  })

  // ===========================================================================
  // Server startup
  // ===========================================================================

  describe('server startup', () => {
    it('starts an HTTP server on the specified port', async () => {
      dashboard = await createDashboardServer({
        port: TEST_PORT,
        storage: mockStorage as any,
        projectId: 'proj-1',
        projectName: 'Test Project',
      })

      expect(dashboard.url).to.equal(`http://localhost:${TEST_PORT}`)
      expect(dashboard.server).to.be.instanceOf(http.Server)
    })

    it('rejects with helpful error on port conflict', async () => {
      dashboard = await createDashboardServer({
        port: TEST_PORT,
        storage: mockStorage as any,
        projectId: 'proj-1',
        projectName: 'Test Project',
      })

      try {
        const conflicting = await createDashboardServer({
          port: TEST_PORT,
          storage: mockStorage as any,
          projectId: 'proj-2',
          projectName: 'Conflict',
        })
        // If we get here, close the second one
        await conflicting.close()
        expect.fail('Should have thrown on port conflict')
      } catch (err) {
        expect((err as Error).message).to.include(`Port ${TEST_PORT} is already in use`)
      }
    })
  })

  // ===========================================================================
  // HTTP routes (structural — no external dependencies)
  // ===========================================================================

  describe('HTTP routes', () => {
    beforeEach(async () => {
      dashboard = await createDashboardServer({
        port: TEST_PORT,
        storage: mockStorage as any,
        projectId: 'proj-1',
        projectName: 'Test Project',
      })
    })

    it('serves HTML on /', (done) => {
      http.get(`http://127.0.0.1:${TEST_PORT}/`, (res) => {
        expect(res.statusCode).to.equal(200)
        expect(res.headers['content-type']).to.include('text/html')

        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk })
        res.on('end', () => {
          expect(body).to.include('<!DOCTYPE html>')
          expect(body).to.include('WebSocket')
          done()
        })
      }).on('error', done)
    })

    it('returns 404 for unknown paths', (done) => {
      http.get(`http://127.0.0.1:${TEST_PORT}/unknown`, (res) => {
        expect(res.statusCode).to.equal(404)
        res.resume()
        res.on('end', done)
      }).on('error', done)
    })

    it('sets CORS headers on all responses', (done) => {
      http.get(`http://127.0.0.1:${TEST_PORT}/`, (res) => {
        expect(res.headers['access-control-allow-origin']).to.equal('*')
        res.resume()
        res.on('end', done)
      }).on('error', done)
    })

    it('no longer serves SSE at /api/events', (done) => {
      http.get(`http://127.0.0.1:${TEST_PORT}/api/events`, (res) => {
        expect(res.statusCode).to.equal(404)
        res.resume()
        res.on('end', done)
      }).on('error', done)
    })
  })

  // ===========================================================================
  // WebSocket
  // ===========================================================================

  describe('WebSocket', () => {
    beforeEach(async () => {
      dashboard = await createDashboardServer({
        port: TEST_PORT,
        storage: mockStorage as any,
        projectId: 'proj-1',
        projectName: 'Test Project',
      })
    })

    it('accepts WebSocket connections and sends initial data', (done) => {
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`)

      ws.on('message', (data: Buffer) => {
        try {
          const parsed = JSON.parse(data.toString())
          expect(parsed).to.have.property('projectId', 'proj-1')
          expect(parsed).to.have.property('projectName', 'Test Project')
          expect(parsed).to.have.property('timestamp')
          expect(parsed).to.have.property('board')
          expect(parsed).to.have.property('agents')
          expect(parsed).to.have.property('sessions')
          expect(parsed).to.have.property('tmuxPeeks')
          ws.close()
          done()
        } catch (err) {
          ws.close()
          done(err)
        }
      })

      ws.on('error', (err) => {
        done(err)
      })
    })
  })

  // ===========================================================================
  // Session API routes
  // ===========================================================================

  describe('Session API', () => {
    beforeEach(async () => {
      dashboard = await createDashboardServer({
        port: TEST_PORT,
        storage: mockStorage as any,
        projectId: 'proj-1',
        projectName: 'Test Project',
      })
    })

    it('GET /api/sessions returns sessions array', (done) => {
      http.get(`http://127.0.0.1:${TEST_PORT}/api/sessions`, (res) => {
        expect(res.statusCode).to.equal(200)
        expect(res.headers['content-type']).to.include('application/json')
        expect(res.headers['access-control-allow-origin']).to.equal('*')

        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk })
        res.on('end', () => {
          const data = JSON.parse(body)
          expect(data).to.have.property('sessions')
          expect(data.sessions).to.be.an('array')
          done()
        })
      }).on('error', done)
    })

    it('GET /api/sessions/:name/peek returns 404 for unknown session', (done) => {
      http.get(`http://127.0.0.1:${TEST_PORT}/api/sessions/nonexistent-session/peek`, (res) => {
        expect(res.statusCode).to.equal(404)
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk })
        res.on('end', () => {
          const data = JSON.parse(body)
          expect(data).to.have.property('error')
          expect(data.error).to.include('Session not found')
          done()
        })
      }).on('error', done)
    })

    it('POST /api/sessions/:name/send returns 404 for unknown session', (done) => {
      const postData = JSON.stringify({ text: 'hello' })
      const req = http.request({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/api/sessions/nonexistent-session/send',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      }, (res) => {
        expect(res.statusCode).to.equal(404)
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk })
        res.on('end', () => {
          const data = JSON.parse(body)
          expect(data).to.have.property('error')
          expect(data.error).to.include('Session not found')
          done()
        })
      })
      req.on('error', done)
      req.write(postData)
      req.end()
    })

    it('POST /api/sessions/:name/send returns 400 when text is missing', (done) => {
      const postData = JSON.stringify({ wrong: 'field' })
      const req = http.request({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/api/sessions/some-session/send',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      }, (res) => {
        expect(res.statusCode).to.equal(400)
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk })
        res.on('end', () => {
          const data = JSON.parse(body)
          expect(data).to.have.property('error')
          expect(data.error).to.include('text field is required')
          done()
        })
      })
      req.on('error', done)
      req.write(postData)
      req.end()
    })

    it('OPTIONS /api/sessions/:name/send returns CORS headers', (done) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/api/sessions/some-session/send',
        method: 'OPTIONS',
      }, (res) => {
        expect(res.statusCode).to.equal(204)
        expect(res.headers['access-control-allow-methods']).to.include('POST')
        expect(res.headers['access-control-allow-headers']).to.include('Content-Type')
        res.resume()
        res.on('end', done)
      })
      req.on('error', done)
      req.end()
    })
  })

  // ===========================================================================
  // close()
  // ===========================================================================

  describe('close()', () => {
    it('stops server from accepting new connections', async () => {
      dashboard = await createDashboardServer({
        port: TEST_PORT,
        storage: mockStorage as any,
        projectId: 'proj-1',
        projectName: 'Test Project',
      })

      await dashboard.close()
      dashboard = null

      await new Promise<void>((resolve) => {
        const req = http.get(`http://127.0.0.1:${TEST_PORT}/`, () => {
          expect.fail('Server should not be listening')
        })
        req.on('error', () => {
          resolve() // ECONNREFUSED — expected
        })
      })
    })
  })
})

import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { SQLiteStorage } from '../../src/lib/pmo/storage-sqlite.js';

/**
 * TKT-017: Smart repo mounting — tickets declare which repos they need.
 *
 * Tests the repos field on tickets: creation, retrieval, update, and clearing.
 */
describe('TKT-017: ticket repos (smart repo mounting)', () => {
  let testDir: string;
  let storage: SQLiteStorage;
  const projectId = 'default';

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-repos-test-'));
    const dbPath = path.join(testDir, 'pmo.db');

    const db = new Database(dbPath);
    db.close();

    storage = new SQLiteStorage(dbPath);

    await storage.createProject({
      id: projectId,
      name: 'Test Project',
      template: 'kanban',
    });
  });

  afterEach(async () => {
    await storage.close();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('createTicket with repos', () => {
    it('creates ticket without repos (backward compatible)', async () => {
      const ticket = await storage.createTicket(projectId, {
        title: 'No repos specified',
        statusName: 'Backlog',
      });

      expect(ticket.repos).to.be.undefined;
    });

    it('creates ticket with single repo', async () => {
      const ticket = await storage.createTicket(projectId, {
        title: 'Single repo ticket',
        statusName: 'Backlog',
        repos: ['frontend'],
      });

      expect(ticket.repos).to.deep.equal(['frontend']);
    });

    it('creates ticket with multiple repos', async () => {
      const ticket = await storage.createTicket(projectId, {
        title: 'Multi-repo ticket',
        statusName: 'Backlog',
        repos: ['frontend', 'backend', 'shared'],
      });

      expect(ticket.repos).to.deep.equal(['frontend', 'backend', 'shared']);
    });

    it('creates ticket with empty repos array (same as no repos)', async () => {
      const ticket = await storage.createTicket(projectId, {
        title: 'Empty repos ticket',
        statusName: 'Backlog',
        repos: [],
      });

      expect(ticket.repos).to.be.undefined;
    });
  });

  describe('getTicket preserves repos', () => {
    it('round-trips repos through create and get', async () => {
      const created = await storage.createTicket(projectId, {
        title: 'Repos round-trip',
        statusName: 'Backlog',
        repos: ['api', 'web'],
      });

      const fetched = await storage.getTicket(created.id);
      expect(fetched).to.not.be.null;
      expect(fetched!.repos).to.deep.equal(['api', 'web']);
    });
  });

  describe('updateTicket repos', () => {
    it('adds repos to a ticket that had none', async () => {
      const ticket = await storage.createTicket(projectId, {
        title: 'Add repos later',
        statusName: 'Backlog',
      });

      const updated = await storage.updateTicket(ticket.id, {
        repos: ['backend'],
      });

      expect(updated.repos).to.deep.equal(['backend']);
    });

    it('changes repos on a ticket', async () => {
      const ticket = await storage.createTicket(projectId, {
        title: 'Change repos',
        statusName: 'Backlog',
        repos: ['frontend'],
      });

      const updated = await storage.updateTicket(ticket.id, {
        repos: ['frontend', 'backend'],
      });

      expect(updated.repos).to.deep.equal(['frontend', 'backend']);
    });

    it('clears repos by setting empty array', async () => {
      const ticket = await storage.createTicket(projectId, {
        title: 'Clear repos',
        statusName: 'Backlog',
        repos: ['frontend', 'backend'],
      });

      const updated = await storage.updateTicket(ticket.id, {
        repos: [],
      });

      expect(updated.repos).to.be.undefined;
    });

    it('does not touch repos when not in update payload', async () => {
      const ticket = await storage.createTicket(projectId, {
        title: 'Untouched repos',
        statusName: 'Backlog',
        repos: ['infra'],
      });

      const updated = await storage.updateTicket(ticket.id, {
        title: 'Renamed ticket',
      });

      expect(updated.repos).to.deep.equal(['infra']);
    });
  });

  describe('listTickets preserves repos', () => {
    it('repos visible in list results', async () => {
      await storage.createTicket(projectId, {
        title: 'Listed ticket',
        statusName: 'Backlog',
        repos: ['mono'],
      });

      const tickets = await storage.listTickets(projectId);
      const found = tickets.find(t => t.title === 'Listed ticket');
      expect(found).to.not.be.undefined;
      expect(found!.repos).to.deep.equal(['mono']);
    });
  });
});

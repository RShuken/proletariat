/**
 * Auto-migration regression tests (TKT-021)
 *
 * Verifies that pending migrations are applied regardless of
 * which code path opens the workspace database:
 * - openWorkspaceDatabase() (RuntimeCommand path)
 * - SQLiteStorage constructor (PMOCommand / direct PMO path)
 *
 * The bug: commands like `ticket list` that reach SQLiteStorage
 * without going through openWorkspaceDatabase() never ran migrations,
 * causing "no such column" errors for columns added by new migrations.
 */

import { expect } from 'chai'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import Database from 'better-sqlite3'
import { runDrizzleMigrations } from '../../src/lib/database/migrator.js'
import { ALL_MIGRATIONS } from '../../src/lib/database/migrations/index.js'
import { SQLiteStorage } from '../../src/lib/pmo/storage-sqlite.js'

describe('Auto-migrate on database open (TKT-021)', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-migrate-'))
  })

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
    const info = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[]
    return info.some(col => col.name === columnName)
  }

  function tableExists(db: Database.Database, tableName: string): boolean {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(tableName)
    return !!row
  }

  /**
   * Create a database that simulates a pre-0025 state:
   * Run all migrations, then wind back by removing migration records for 0025+
   * and undoing their schema effects. This simulates the state before TKT-017
   * added the repos column.
   */
  function createDatabaseAtMigration0024(dbPath: string): void {
    const db = new Database(dbPath)
    db.pragma('foreign_keys = ON')

    // Apply ALL migrations first to get a fully-formed DB
    runDrizzleMigrations(db, ALL_MIGRATIONS)

    // Now wind back: remove migration records for 0025+ and undo their effects
    db.exec("DELETE FROM prlt_migrations WHERE CAST(id AS INTEGER) >= 25")

    // Remove repos column by recreating pmo_tickets without it
    db.pragma('foreign_keys = OFF')
    const cols = db.prepare('PRAGMA table_info(pmo_tickets)').all() as {
      name: string; type: string; notnull: number; dflt_value: string | null; pk: number
    }[]
    const colsWithoutRepos = cols.filter(c => c.name !== 'repos')
    const colDefs = colsWithoutRepos.map(c => {
      let def = `${c.name} ${c.type}`
      if (c.notnull && !c.pk) def += ' NOT NULL'
      if (c.dflt_value !== null) def += ` DEFAULT ${c.dflt_value}`
      if (c.pk) def += ' PRIMARY KEY'
      return def
    }).join(', ')
    const colNames = colsWithoutRepos.map(c => c.name).join(', ')

    db.exec(`
      CREATE TABLE pmo_tickets_backup (${colDefs});
      INSERT INTO pmo_tickets_backup (${colNames}) SELECT ${colNames} FROM pmo_tickets;
      DROP TABLE pmo_tickets;
      ALTER TABLE pmo_tickets_backup RENAME TO pmo_tickets;
    `)

    // Remove message_queue table (from migration 0027)
    db.exec('DROP TABLE IF EXISTS message_queue')

    db.pragma('foreign_keys = ON')

    // Verify pre-conditions
    expect(columnExists(db, 'pmo_tickets', 'repos')).to.be.false
    expect(tableExists(db, 'message_queue')).to.be.false

    db.close()
  }

  describe('SQLiteStorage auto-migration', () => {
    it('applies pending migrations when opened at an old migration level', async () => {
      const dbPath = path.join(testDir, 'workspace.db')
      createDatabaseAtMigration0024(dbPath)

      // Open via SQLiteStorage (the PMO path that previously skipped migrations)
      const storage = new SQLiteStorage(dbPath)

      try {
        const db = storage.getDatabase()

        // Verify migration 0025 (ticket_repos) was applied
        expect(columnExists(db, 'pmo_tickets', 'repos')).to.be.true

        // Verify migration 0027 (message_queue) was applied
        expect(tableExists(db, 'message_queue')).to.be.true

        // Verify we can actually use the repos column without error
        await storage.createProject({
          id: 'test-project',
          name: 'Test Project',
          template: 'kanban',
        })
        const ticket = await storage.createTicket('test-project', {
          title: 'Test ticket with repos',
          repos: ['repo-a', 'repo-b'],
        })
        expect(ticket.repos).to.deep.equal(['repo-a', 'repo-b'])
      } finally {
        await storage.close()
      }
    })

    it('is idempotent — re-opening does not fail or double-apply', async () => {
      const dbPath = path.join(testDir, 'workspace.db')
      createDatabaseAtMigration0024(dbPath)

      // First open triggers migrations
      const storage1 = new SQLiteStorage(dbPath)
      const db1 = storage1.getDatabase()
      const migrationsAfterFirst = db1.prepare(
        'SELECT id FROM prlt_migrations ORDER BY id'
      ).all() as { id: string }[]
      await storage1.close()

      // Second open should be a no-op for migrations
      const storage2 = new SQLiteStorage(dbPath)
      const db2 = storage2.getDatabase()
      const migrationsAfterSecond = db2.prepare(
        'SELECT id FROM prlt_migrations ORDER BY id'
      ).all() as { id: string }[]
      await storage2.close()

      expect(migrationsAfterFirst).to.deep.equal(migrationsAfterSecond)
    })
  })

  describe('Migration ID uniqueness', () => {
    it('ALL_MIGRATIONS has no duplicate IDs', () => {
      const ids = ALL_MIGRATIONS.map(m => m.id)
      const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i)

      expect(duplicates, `Duplicate migration IDs found: ${duplicates.join(', ')}`).to.have.length(0)
      expect(new Set(ids).size).to.equal(ALL_MIGRATIONS.length)
    })
  })
})

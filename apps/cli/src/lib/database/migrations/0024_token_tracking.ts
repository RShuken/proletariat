/**
 * Migration 0023 — Token Tracking
 *
 * Adds token usage and cost columns to agent_work for tracking
 * per-session Claude API consumption.
 */

import type Database from 'better-sqlite3'
import type { Migration } from '../migrator.js'

export const tokenTracking: Migration = {
  id: '0023',
  name: 'token_tracking',
  up: (db: Database.Database) => {
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_work'"
    ).get()
    if (!tableExists) return

    // Check if columns already exist (idempotent)
    const cols = db.prepare('PRAGMA table_info(agent_work)').all() as Array<{ name: string }>
    const colNames = new Set(cols.map(c => c.name))
    if (colNames.has('input_tokens')) return

    db.exec(`
      ALTER TABLE agent_work ADD COLUMN input_tokens INTEGER DEFAULT 0;
      ALTER TABLE agent_work ADD COLUMN output_tokens INTEGER DEFAULT 0;
      ALTER TABLE agent_work ADD COLUMN cache_read_tokens INTEGER DEFAULT 0;
      ALTER TABLE agent_work ADD COLUMN cache_creation_tokens INTEGER DEFAULT 0;
      ALTER TABLE agent_work ADD COLUMN model TEXT;
      ALTER TABLE agent_work ADD COLUMN estimated_cost_usd REAL DEFAULT 0;
    `)
  },
}

/**
 * Migration 0025 — Ticket Repos
 *
 * Adds a repos JSON column to pmo_tickets for smart repo mounting.
 * When an agent spawns via `prlt work start`, it can create worktrees
 * for only the repos specified on the ticket instead of all repos.
 */

import type Database from 'better-sqlite3'
import type { Migration } from '../migrator.js'

export const ticketRepos: Migration = {
  id: '0025',
  name: 'ticket_repos',
  up: (db: Database.Database) => {
    const cols = db.prepare('PRAGMA table_info(pmo_tickets)').all() as Array<{ name: string }>
    const colNames = new Set(cols.map(c => c.name))
    if (colNames.has('repos')) return

    db.exec(`ALTER TABLE pmo_tickets ADD COLUMN repos TEXT DEFAULT NULL;`)
  },
}

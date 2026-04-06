/**
 * Migration 0025 — Watchdog Settings
 *
 * Seeds default watchdog configuration into workspace_settings.
 * The agent watchdog monitors running sessions for context exhaustion,
 * crashes, stuck agents, and permission prompts.
 */

import type Database from 'better-sqlite3'
import type { Migration } from '../migrator.js'

export const watchdogSettings: Migration = {
  id: '0026',
  name: 'watchdog_settings',
  up: (db: Database.Database) => {
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_settings'"
    ).get()
    if (!tableExists) return

    // Seed default watchdog settings (INSERT OR IGNORE to preserve user overrides)
    const insert = db.prepare(
      "INSERT OR IGNORE INTO workspace_settings (key, value) VALUES (?, ?)"
    )

    insert.run('watchdog.enabled', 'true')
    insert.run('watchdog.context_detection', 'true')
    insert.run('watchdog.crash_recovery', 'true')
    insert.run('watchdog.stuck_detection', 'true')
    insert.run('watchdog.auto_permit', 'true')
    insert.run('watchdog.context_threshold', '0.20')
    insert.run('watchdog.stuck_timeout_secs', '300')
  },
}

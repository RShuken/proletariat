/**
 * Migration 0028 — Auto-Respond Settings
 *
 * Seeds default auto-respond configuration into workspace_settings.
 * The auto-responder detects stuck prompts in tmux agent sessions and
 * auto-responds based on prompt category and permission mode.
 */

import type Database from 'better-sqlite3'
import type { Migration } from '../migrator.js'

export const autoRespondSettings: Migration = {
  id: '0028',
  name: 'auto_respond_settings',
  up: (db: Database.Database) => {
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_settings'"
    ).get()
    if (!tableExists) return

    // Seed default auto-respond settings (INSERT OR IGNORE to preserve user overrides)
    const insert = db.prepare(
      "INSERT OR IGNORE INTO workspace_settings (key, value) VALUES (?, ?)"
    )

    // Auto-respond is enabled by default when in YOLO/danger mode
    insert.run('auto_respond.enabled', 'true')
    // Cooldown between auto-responses per session (seconds)
    insert.run('auto_respond.cooldown_secs', '10')
  },
}

/**
 * Migration 0027 — Message Queue
 *
 * Adds the message_queue table for agent-to-agent communication.
 * Messages flow through this queue and are delivered via tmux send-keys.
 */

import type Database from 'better-sqlite3'
import type { Migration } from '../migrator.js'

export const messageQueue: Migration = {
  id: '0027',
  name: 'message_queue',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'read')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        delivered_at TEXT,
        read_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_message_queue_to_status
        ON message_queue(to_agent, status);

      CREATE INDEX IF NOT EXISTS idx_message_queue_created
        ON message_queue(created_at);
    `)
  },
}

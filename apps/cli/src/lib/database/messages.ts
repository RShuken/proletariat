/**
 * Message Queue DAL
 *
 * Database operations for agent-to-agent messaging.
 * All access goes through withDrizzle for connection management.
 */

import { eq, and, desc } from 'drizzle-orm'
import { messageQueue } from './drizzle-schema.js'
import { withDrizzle } from './workspace.js'

export interface QueuedMessage {
  id: number
  fromAgent: string
  toAgent: string
  message: string
  status: 'pending' | 'delivered' | 'read'
  createdAt: string | null
  deliveredAt: string | null
  readAt: string | null
}

function rowToMessage(row: Record<string, unknown>): QueuedMessage {
  return {
    id: row.id as number,
    fromAgent: row.from_agent as string,
    toAgent: row.to_agent as string,
    message: row.message as string,
    status: row.status as 'pending' | 'delivered' | 'read',
    createdAt: (row.created_at as string) ?? null,
    deliveredAt: (row.delivered_at as string) ?? null,
    readAt: (row.read_at as string) ?? null,
  }
}

/**
 * Enqueue a message from one agent to another.
 */
export function enqueueMessage(
  workspacePath: string,
  fromAgent: string,
  toAgent: string,
  message: string,
): QueuedMessage {
  return withDrizzle(workspacePath, (_ddb, sqliteDb) => {
    const stmt = sqliteDb.prepare(`
      INSERT INTO message_queue (from_agent, to_agent, message, status, created_at)
      VALUES (?, ?, ?, 'pending', datetime('now'))
    `)
    const result = stmt.run(fromAgent, toAgent, message)
    const row = sqliteDb.prepare('SELECT * FROM message_queue WHERE id = ?').get(result.lastInsertRowid) as Record<string, unknown>
    return rowToMessage(row)
  })
}

/**
 * Enqueue a broadcast message (one row per recipient).
 */
export function enqueueBroadcast(
  workspacePath: string,
  fromAgent: string,
  toAgents: string[],
  message: string,
): QueuedMessage[] {
  return withDrizzle(workspacePath, (_ddb, sqliteDb) => {
    if (toAgents.length === 0) return []
    const stmt = sqliteDb.prepare(`
      INSERT INTO message_queue (from_agent, to_agent, message, status, created_at)
      VALUES (?, ?, ?, 'pending', datetime('now'))
    `)
    const results: QueuedMessage[] = []
    const txn = sqliteDb.transaction(() => {
      for (const to of toAgents) {
        const result = stmt.run(fromAgent, to, message)
        const row = sqliteDb.prepare('SELECT * FROM message_queue WHERE id = ?').get(result.lastInsertRowid) as Record<string, unknown>
        results.push(rowToMessage(row))
      }
    })
    txn()
    return results
  })
}

/**
 * Get pending messages for a specific agent.
 */
export function getPendingMessages(
  workspacePath: string,
  agentName: string,
): QueuedMessage[] {
  return withDrizzle(workspacePath, (ddb) => {
    const rows = ddb.select().from(messageQueue)
      .where(and(
        eq(messageQueue.toAgent, agentName),
        eq(messageQueue.status, 'pending'),
      ))
      .orderBy(desc(messageQueue.createdAt))
      .all()
    return rows.map((r) => ({
      id: r.id,
      fromAgent: r.fromAgent,
      toAgent: r.toAgent,
      message: r.message,
      status: r.status as 'pending' | 'delivered' | 'read',
      createdAt: r.createdAt,
      deliveredAt: r.deliveredAt,
      readAt: r.readAt,
    }))
  })
}

/**
 * Get all messages for an agent (any status).
 */
export function getMessagesForAgent(
  workspacePath: string,
  agentName: string,
  limit = 50,
): QueuedMessage[] {
  return withDrizzle(workspacePath, (ddb) => {
    const rows = ddb.select().from(messageQueue)
      .where(eq(messageQueue.toAgent, agentName))
      .orderBy(desc(messageQueue.createdAt))
      .limit(limit)
      .all()
    return rows.map((r) => ({
      id: r.id,
      fromAgent: r.fromAgent,
      toAgent: r.toAgent,
      message: r.message,
      status: r.status as 'pending' | 'delivered' | 'read',
      createdAt: r.createdAt,
      deliveredAt: r.deliveredAt,
      readAt: r.readAt,
    }))
  })
}

/**
 * Mark a message as delivered.
 */
export function markMessageDelivered(
  workspacePath: string,
  messageId: number,
): void {
  withDrizzle(workspacePath, (ddb) => {
    ddb.update(messageQueue)
      .set({
        status: 'delivered',
        deliveredAt: new Date().toISOString(),
      })
      .where(eq(messageQueue.id, messageId))
      .run()
  })
}

/**
 * Mark a message as read.
 */
export function markMessageRead(
  workspacePath: string,
  messageId: number,
): void {
  withDrizzle(workspacePath, (ddb) => {
    ddb.update(messageQueue)
      .set({
        status: 'read',
        readAt: new Date().toISOString(),
      })
      .where(eq(messageQueue.id, messageId))
      .run()
  })
}

/**
 * Get all pending messages (for the delivery daemon).
 * Returns messages grouped by target agent.
 */
export function getAllPendingMessages(
  workspacePath: string,
): QueuedMessage[] {
  return withDrizzle(workspacePath, (ddb) => {
    const rows = ddb.select().from(messageQueue)
      .where(eq(messageQueue.status, 'pending'))
      .orderBy(messageQueue.toAgent, messageQueue.createdAt)
      .all()
    return rows.map((r) => ({
      id: r.id,
      fromAgent: r.fromAgent,
      toAgent: r.toAgent,
      message: r.message,
      status: r.status as 'pending' | 'delivered' | 'read',
      createdAt: r.createdAt,
      deliveredAt: r.deliveredAt,
      readAt: r.readAt,
    }))
  })
}

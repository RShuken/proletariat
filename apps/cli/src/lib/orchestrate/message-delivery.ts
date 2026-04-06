/**
 * Message Delivery Daemon
 *
 * Polls the message_queue table for pending messages and delivers them
 * to target agent tmux sessions via send-keys. Runs as part of the
 * orchestrate daemon on a 5-second interval.
 */

import { execFileSync } from 'node:child_process'
import {
  getAllPendingMessages,
  markMessageDelivered,
} from '../database/index.js'
import { getAgentTmuxSessions } from '../agents/commands.js'

export const MESSAGE_DELIVERY_INTERVAL_MS = 5_000

export interface MessageDeliveryOptions {
  workspacePath: string
  log: (msg: string) => void
}

export class MessageDelivery {
  private workspacePath: string
  private log: (msg: string) => void

  constructor(options: MessageDeliveryOptions) {
    this.workspacePath = options.workspacePath
    this.log = options.log
  }

  /**
   * Check for pending messages and deliver them to agent tmux sessions.
   */
  async deliverPending(): Promise<number> {
    let delivered = 0

    try {
      const pending = getAllPendingMessages(this.workspacePath)
      if (pending.length === 0) return 0

      for (const msg of pending) {
        const sessions = getAgentTmuxSessions(msg.toAgent)
        if (sessions.length === 0) {
          // Agent not running — leave message pending for later delivery
          continue
        }

        const sessionName = sessions[0]
        const formatted = `[MSG from ${msg.fromAgent}]: ${msg.message}`

        try {
          // Send via tmux send-keys -l (literal mode, no shell interpretation)
          execFileSync('tmux', ['send-keys', '-t', sessionName, '-l', formatted], {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 5000,
          })
          execFileSync('tmux', ['send-keys', '-t', sessionName, 'Enter'], {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 5000,
          })

          markMessageDelivered(this.workspacePath, msg.id)
          delivered++
          this.log(`Delivered message #${msg.id}: ${msg.fromAgent} → ${msg.toAgent}`)
        } catch (err) {
          this.log(`Failed to deliver message #${msg.id} to ${msg.toAgent}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } catch (err) {
      this.log(`Message delivery error: ${err instanceof Error ? err.message : String(err)}`)
    }

    return delivered
  }
}

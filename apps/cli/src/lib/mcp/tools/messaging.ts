/**
 * MCP Messaging Tools
 *
 * Allows Claude Code agents to send messages to other agents
 * and check their inbox programmatically via the MCP protocol.
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpToolContext } from '../types.js'
import { strictTool, successResponse, errorResponse } from '../helpers.js'
import {
  enqueueMessage,
  enqueueBroadcast,
  getPendingMessages,
  getMessagesForAgent,
  markMessageRead,
} from '../../database/index.js'
import { getAgentTmuxSessions } from '../../agents/commands.js'

export function registerMessagingTools(server: McpServer, ctx: McpToolContext): void {
  // ── agent_send_message ──────────────────────────────────────────────
  strictTool(server,
    'agent_send_message',
    'Send a message to another agent via the message queue. Messages are delivered to the target agent\'s tmux session by the orchestrate daemon.',
    {
      to_agent: z.string().describe('Target agent name'),
      message: z.string().describe('Message content'),
      from_agent: z.string().optional().describe('Sender name (defaults to PRLT_AGENT_NAME or "mcp-client")'),
    },
    async (params) => {
      try {
        const wsCtx = ctx.getWorkspaceContext?.()
        if (!wsCtx) {
          return errorResponse(new Error('Not in a workspace context'))
        }
        const from = params.from_agent || process.env.PRLT_AGENT_NAME || 'mcp-client'
        const queued = enqueueMessage(
          wsCtx.workspaceInfo.path,
          from,
          params.to_agent,
          params.message,
        )
        return successResponse({
          id: queued.id,
          from,
          to: params.to_agent,
          message: params.message,
          status: queued.status,
        })
      } catch (error) {
        return errorResponse(error)
      }
    }
  )

  // ── agent_broadcast_message ─────────────────────────────────────────
  strictTool(server,
    'agent_broadcast_message',
    'Broadcast a message to all running agents. Each agent gets a copy in their message queue.',
    {
      message: z.string().describe('Message to broadcast'),
      from_agent: z.string().optional().describe('Sender name (defaults to PRLT_AGENT_NAME or "mcp-client")'),
    },
    async (params) => {
      try {
        const wsCtx = ctx.getWorkspaceContext?.()
        if (!wsCtx) {
          return errorResponse(new Error('Not in a workspace context'))
        }
        const from = params.from_agent || process.env.PRLT_AGENT_NAME || 'mcp-client'

        // Find running agents
        const activeAgents = wsCtx.workspaceInfo.agents
          .filter((a) => a.status === 'active' || a.status === 'running')
          .filter((a) => getAgentTmuxSessions(a.name).length > 0)
          .map((a) => a.name)
          .filter((name) => name !== from)

        if (activeAgents.length === 0) {
          return successResponse({ recipients: [], count: 0, message: 'No running agents to broadcast to.' })
        }

        const queued = enqueueBroadcast(
          wsCtx.workspaceInfo.path,
          from,
          activeAgents,
          params.message,
        )

        return successResponse({
          from,
          recipients: activeAgents,
          count: queued.length,
          messageIds: queued.map((m) => m.id),
        })
      } catch (error) {
        return errorResponse(error)
      }
    }
  )

  // ── agent_check_messages ────────────────────────────────────────────
  strictTool(server,
    'agent_check_messages',
    'Check the message inbox for an agent. Returns pending messages by default.',
    {
      agent_name: z.string().optional().describe('Agent to check (defaults to PRLT_AGENT_NAME)'),
      include_all: z.boolean().optional().describe('Include delivered/read messages too (default false)'),
      mark_read: z.boolean().optional().describe('Mark returned messages as read (default false)'),
    },
    async (params) => {
      try {
        const wsCtx = ctx.getWorkspaceContext?.()
        if (!wsCtx) {
          return errorResponse(new Error('Not in a workspace context'))
        }
        const agentName = params.agent_name || process.env.PRLT_AGENT_NAME
        if (!agentName) {
          return errorResponse(new Error('Specify agent_name or set PRLT_AGENT_NAME'))
        }

        const messages = params.include_all
          ? getMessagesForAgent(wsCtx.workspaceInfo.path, agentName)
          : getPendingMessages(wsCtx.workspaceInfo.path, agentName)

        if (params.mark_read) {
          for (const msg of messages) {
            if (msg.status !== 'read') {
              markMessageRead(wsCtx.workspaceInfo.path, msg.id)
            }
          }
        }

        return successResponse({
          agent: agentName,
          count: messages.length,
          messages: messages.map((m) => ({
            id: m.id,
            from: m.fromAgent,
            message: m.message,
            status: m.status,
            createdAt: m.createdAt,
          })),
        })
      } catch (error) {
        return errorResponse(error)
      }
    }
  )
}

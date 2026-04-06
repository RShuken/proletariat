/**
 * prlt msg broadcast <message> — send a message to all running agents
 */

import { Args, Flags } from '@oclif/core'
import { PromptCommand } from '../../lib/prompt-command.js'
import { machineOutputFlags } from '../../lib/pmo/index.js'
import {
  shouldOutputJson,
  outputSuccessAsJson,
  outputErrorAsJson,
  createMetadata,
} from '../../lib/prompt-json.js'
import { styles } from '../../lib/styles.js'
import {
  getWorkspaceInfo,
  getAgentTmuxSessions,
} from '../../lib/agents/commands.js'
import { enqueueBroadcast } from '../../lib/database/index.js'

export default class MsgBroadcast extends PromptCommand {
  static description = 'Broadcast a message to all running agents'

  static examples = [
    '<%= config.bin %> msg broadcast "deploy freeze starts in 10 minutes"',
    '<%= config.bin %> msg broadcast --from orchestrator "rebase on main"',
  ]

  static args = {
    message: Args.string({
      description: 'Message to broadcast',
      required: true,
    }),
  }

  static flags = {
    ...machineOutputFlags,
    from: Flags.string({
      description: 'Sender name (defaults to PRLT_AGENT_NAME or "operator")',
    }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MsgBroadcast)
    const jsonMode = shouldOutputJson(flags)

    let workspaceInfo
    try {
      workspaceInfo = getWorkspaceInfo()
    } catch {
      if (jsonMode) {
        outputErrorAsJson('NOT_IN_WORKSPACE', 'Not in a workspace.', createMetadata('msg broadcast', flags))
        return
      }
      this.error('Not in a workspace. Run "prlt new" first.')
    }

    const fromAgent = flags.from || process.env.PRLT_AGENT_NAME || 'operator'

    // Find all agents with running tmux sessions
    const activeAgents = workspaceInfo.agents
      .filter((a) => a.status === 'active' || a.status === 'running')
      .filter((a) => {
        const sessions = getAgentTmuxSessions(a.name)
        return sessions.length > 0
      })
      .map((a) => a.name)
      .filter((name) => name !== fromAgent) // don't send to self

    if (activeAgents.length === 0) {
      if (jsonMode) {
        outputSuccessAsJson({ recipients: [], count: 0 }, createMetadata('msg broadcast', flags))
        return
      }
      this.log(styles.muted('No running agents to broadcast to.'))
      return
    }

    const queued = enqueueBroadcast(workspaceInfo.path, fromAgent, activeAgents, args.message)

    if (jsonMode) {
      outputSuccessAsJson({
        from: fromAgent,
        recipients: activeAgents,
        count: queued.length,
        messageIds: queued.map((m) => m.id),
      }, createMetadata('msg broadcast', flags))
      return
    }

    this.log(styles.success(`Broadcast queued to ${activeAgents.length} agent(s): ${activeAgents.join(', ')}`))
    this.log(styles.muted(`  "${args.message}"`))
  }
}

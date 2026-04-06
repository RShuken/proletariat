/**
 * prlt msg list — show pending/recent messages for an agent
 */

import { Flags } from '@oclif/core'
import chalk from 'chalk'
import { PromptCommand } from '../../lib/prompt-command.js'
import { machineOutputFlags } from '../../lib/pmo/index.js'
import {
  shouldOutputJson,
  outputSuccessAsJson,
  outputErrorAsJson,
  createMetadata,
} from '../../lib/prompt-json.js'
import { getWorkspaceInfo } from '../../lib/agents/commands.js'
import {
  getPendingMessages,
  getMessagesForAgent,
  markMessageRead,
} from '../../lib/database/index.js'

export default class MsgList extends PromptCommand {
  static description = 'List messages for an agent'

  static examples = [
    '<%= config.bin %> msg list --agent bold-fox',
    '<%= config.bin %> msg list --all',
  ]

  static flags = {
    ...machineOutputFlags,
    agent: Flags.string({
      description: 'Agent name to check messages for (defaults to PRLT_AGENT_NAME)',
      char: 'a',
    }),
    all: Flags.boolean({
      description: 'Show all messages (not just pending)',
      default: false,
    }),
    'mark-read': Flags.boolean({
      description: 'Mark listed messages as read',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(MsgList)
    const jsonMode = shouldOutputJson(flags)

    let workspaceInfo
    try {
      workspaceInfo = getWorkspaceInfo()
    } catch {
      if (jsonMode) {
        outputErrorAsJson('NOT_IN_WORKSPACE', 'Not in a workspace.', createMetadata('msg list', flags))
        return
      }
      this.error('Not in a workspace. Run "prlt new" first.')
    }

    const agentName = flags.agent || process.env.PRLT_AGENT_NAME
    if (!agentName) {
      if (jsonMode) {
        outputErrorAsJson('NO_AGENT', 'Specify --agent or set PRLT_AGENT_NAME.', createMetadata('msg list', flags))
        return
      }
      this.error('Specify --agent <name> or set PRLT_AGENT_NAME env var.')
    }

    const messages = flags.all
      ? getMessagesForAgent(workspaceInfo.path, agentName)
      : getPendingMessages(workspaceInfo.path, agentName)

    if (flags['mark-read']) {
      for (const msg of messages) {
        if (msg.status === 'pending' || msg.status === 'delivered') {
          markMessageRead(workspaceInfo.path, msg.id)
        }
      }
    }

    if (jsonMode) {
      outputSuccessAsJson({
        agent: agentName,
        count: messages.length,
        messages: messages.map((m) => ({
          id: m.id,
          from: m.fromAgent,
          message: m.message,
          status: m.status,
          createdAt: m.createdAt,
        })),
      }, createMetadata('msg list', flags))
      return
    }

    if (messages.length === 0) {
      this.log(chalk.dim(`No ${flags.all ? '' : 'pending '}messages for ${agentName}.`))
      return
    }

    this.log(chalk.bold(`\nMessages for ${agentName}:\n`))
    for (const msg of messages) {
      const statusIcon = msg.status === 'pending' ? '📨' : msg.status === 'delivered' ? '📬' : '✅'
      this.log(`${statusIcon} #${msg.id} from ${chalk.cyan(msg.fromAgent)} ${chalk.dim(`(${msg.status})`)}`)
      this.log(`   ${msg.message}`)
      this.log(chalk.dim(`   ${msg.createdAt}`))
      this.log('')
    }
  }
}

/**
 * prlt msg send <agent> <message> — queue a message for another agent
 *
 * Writes to the message_queue table. The orchestrate daemon delivers
 * pending messages to agent tmux sessions every 5 seconds.
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
import { getWorkspaceInfo } from '../../lib/agents/commands.js'
import { enqueueMessage } from '../../lib/database/index.js'

export default class MsgSend extends PromptCommand {
  static description = 'Send a message to another agent via the message queue'

  static examples = [
    '<%= config.bin %> msg send bold-fox "please review the auth module"',
    '<%= config.bin %> msg send --from swift-owl bold-fox "I finished the API"',
  ]

  static args = {
    agent: Args.string({
      description: 'Target agent name',
      required: true,
    }),
    message: Args.string({
      description: 'Message to send',
      required: true,
    }),
  }

  static flags = {
    ...machineOutputFlags,
    from: Flags.string({
      description: 'Sender agent name (defaults to PRLT_AGENT_NAME or "operator")',
    }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MsgSend)
    const jsonMode = shouldOutputJson(flags)

    let workspaceInfo
    try {
      workspaceInfo = getWorkspaceInfo()
    } catch {
      if (jsonMode) {
        outputErrorAsJson('NOT_IN_WORKSPACE', 'Not in a workspace. Run "prlt new" first.', createMetadata('msg send', flags))
        return
      }
      this.error('Not in a workspace. Run "prlt new" first.')
    }

    const fromAgent = flags.from || process.env.PRLT_AGENT_NAME || 'operator'
    const toAgent = args.agent
    const message = args.message

    const queued = enqueueMessage(workspaceInfo.path, fromAgent, toAgent, message)

    if (jsonMode) {
      outputSuccessAsJson({
        id: queued.id,
        from: fromAgent,
        to: toAgent,
        message,
        status: queued.status,
      }, createMetadata('msg send', flags))
      return
    }

    this.log(styles.success(`Message queued (#${queued.id}): ${fromAgent} → ${toAgent}`))
    this.log(styles.muted(`  "${message}"`))
  }
}

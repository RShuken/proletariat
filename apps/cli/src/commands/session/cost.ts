/**
 * Session Cost Command (TKT-013)
 *
 * Shows daily token usage and cost aggregation across agent sessions.
 *
 * Usage:
 *   prlt session cost              # Last 30 days
 *   prlt session cost --days 7     # Last 7 days
 *   prlt session cost --agent ava  # Filter by agent
 */

import { Flags } from '@oclif/core'
import { getWorkspaceInfo } from '../../lib/agents/commands.js'
import { openWorkspaceDatabase } from '../../lib/database/index.js'
import { ExecutionStorage } from '../../lib/execution/index.js'
import { formatTokenCount, formatCost } from '../../lib/execution/token-parser.js'
import { PromptCommand } from '../../lib/prompt-command.js'
import { styles } from '../../lib/styles.js'
import { machineOutputFlags } from '../../lib/pmo/index.js'
import {
  shouldOutputJson,
  outputSuccessAsJson,
  outputErrorAsJson,
  createMetadata,
} from '../../lib/prompt-json.js'

export default class SessionCost extends PromptCommand {
  static description = 'Show daily token usage and cost across agent sessions'

  static examples = [
    '<%= config.bin %> session cost',
    '<%= config.bin %> session cost --days 7',
    '<%= config.bin %> session cost --agent ava',
    '<%= config.bin %> session cost --json',
  ]

  static flags = {
    ...machineOutputFlags,
    days: Flags.integer({
      char: 'd',
      description: 'Number of days to show',
      default: 30,
    }),
    agent: Flags.string({
      char: 'a',
      description: 'Filter by agent name',
    }),
  }

  protected getPMOOptions() {
    return { promptIfMultiple: false }
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(SessionCost)
    const jsonMode = shouldOutputJson(flags)

    let workspaceInfo
    try {
      workspaceInfo = getWorkspaceInfo()
    } catch {
      if (jsonMode) {
        outputErrorAsJson('NOT_IN_WORKSPACE', 'Not in a workspace.', createMetadata('session cost', flags))
        return
      }
      this.error('Not in a workspace.')
      return
    }

    const db = openWorkspaceDatabase(workspaceInfo.path)
    const executionStorage = new ExecutionStorage(db)

    try {
      const dailyUsage = executionStorage.getDailyTokenUsage({
        days: flags.days,
        agentName: flags.agent,
      })

      if (jsonMode) {
        const totals = dailyUsage.reduce(
          (acc, day) => ({
            sessionCount: acc.sessionCount + day.sessionCount,
            inputTokens: acc.inputTokens + day.inputTokens,
            outputTokens: acc.outputTokens + day.outputTokens,
            cacheReadTokens: acc.cacheReadTokens + day.cacheReadTokens,
            cacheCreationTokens: acc.cacheCreationTokens + day.cacheCreationTokens,
            estimatedCostUsd: acc.estimatedCostUsd + day.estimatedCostUsd,
          }),
          { sessionCount: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, estimatedCostUsd: 0 },
        )
        outputSuccessAsJson({
          days: dailyUsage.map(d => ({
            date: d.date,
            sessionCount: d.sessionCount,
            inputTokens: d.inputTokens,
            outputTokens: d.outputTokens,
            cacheReadTokens: d.cacheReadTokens,
            cacheCreationTokens: d.cacheCreationTokens,
            estimatedCostUsd: d.estimatedCostUsd,
          })),
          totals,
        }, createMetadata('session cost', flags))
        return
      }

      if (dailyUsage.length === 0) {
        this.log('')
        this.log(styles.muted('No token usage data found.'))
        this.log('')
        return
      }

      // Header
      this.log('')
      this.log(styles.header(`Token Usage (last ${flags.days} days${flags.agent ? `, agent: ${flags.agent}` : ''})`))
      this.log('')

      // Table header
      const header = `  ${'Date'.padEnd(12)} ${'Sessions'.padStart(8)} ${'Input'.padStart(10)} ${'Output'.padStart(10)} ${'Cache Read'.padStart(10)} ${'Cost'.padStart(10)}`
      this.log(styles.muted(header))
      this.log(styles.muted('  ' + '-'.repeat(header.length - 2)))

      // Daily rows
      let totalSessions = 0
      let totalInput = 0
      let totalOutput = 0
      let totalCacheRead = 0
      let totalCost = 0

      for (const day of dailyUsage) {
        totalSessions += day.sessionCount
        totalInput += day.inputTokens
        totalOutput += day.outputTokens
        totalCacheRead += day.cacheReadTokens
        totalCost += day.estimatedCostUsd

        this.log(
          `  ${day.date.padEnd(12)} ${String(day.sessionCount).padStart(8)} ${formatTokenCount(day.inputTokens).padStart(10)} ${formatTokenCount(day.outputTokens).padStart(10)} ${formatTokenCount(day.cacheReadTokens).padStart(10)} ${formatCost(day.estimatedCostUsd).padStart(10)}`,
        )
      }

      // Totals
      this.log(styles.muted('  ' + '-'.repeat(header.length - 2)))
      this.log(
        styles.info(
          `  ${'TOTAL'.padEnd(12)} ${String(totalSessions).padStart(8)} ${formatTokenCount(totalInput).padStart(10)} ${formatTokenCount(totalOutput).padStart(10)} ${formatTokenCount(totalCacheRead).padStart(10)} ${formatCost(totalCost).padStart(10)}`,
        ),
      )
      this.log('')
    } finally {
      db.close()
    }
  }
}

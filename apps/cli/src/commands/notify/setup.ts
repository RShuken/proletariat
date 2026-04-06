/**
 * prlt notify setup — Interactive webhook setup wizard.
 *
 * Prompts for a webhook URL, format preset, and optional secret,
 * stores settings in workspace_settings, creates a webhook provider,
 * auto-wires rules for agent lifecycle events, and sends a test ping.
 *
 * Examples:
 *   prlt notify setup
 *   prlt notify setup --url https://example.com/webhook --format slack
 */

import { Flags } from '@oclif/core'
import { RuntimeCommand, machineOutputFlags } from '../../lib/runtime-command.js'
import {
  shouldOutputJson,
  outputSuccessAsJson,
  outputErrorAsJson,
  outputPromptAsJson,
  buildPromptConfig,
  createMetadata,
} from '../../lib/prompt-json.js'
import { styles } from '../../lib/styles.js'
import {
  NotificationStorage,
  dispatchNotification,
  WEBHOOK_FORMATS,
  type WebhookProviderConfig,
  type WebhookFormat,
} from '../../lib/notifications/index.js'
import { SettingsStore } from '../../lib/database/settings-store.js'
import inquirer from 'inquirer'

/** Agent lifecycle events to auto-wire with webhook rules. */
const AGENT_LIFECYCLE_EVENTS = [
  'on_agent_completed',
  'on_agent_died',
  'on_agent_idle',
  'on_agent_needs_input',
] as const

export default class NotifySetup extends RuntimeCommand {
  static description = 'Set up webhook notifications for agent events'

  static examples = [
    '<%= config.bin %> notify setup',
    '<%= config.bin %> notify setup --url https://example.com/webhook --format slack',
    '<%= config.bin %> notify setup --url https://hooks.slack.com/... --format slack --secret mysecret',
  ]

  static flags = {
    ...machineOutputFlags,
    url: Flags.string({
      description: 'Webhook URL to POST notifications to',
    }),
    format: Flags.string({
      description: 'Payload format preset',
      options: WEBHOOK_FORMATS,
    }),
    secret: Flags.string({
      description: 'HMAC-SHA256 signing secret for X-Webhook-Signature header',
    }),
    name: Flags.string({
      description: 'Provider name (default: webhook)',
    }),
    'skip-test': Flags.boolean({
      description: 'Skip the test ping after setup',
      default: false,
    }),
  }

  async execute(): Promise<void> {
    const { flags } = await this.parse(NotifySetup)
    const jsonMode = shouldOutputJson(flags)
    const db = this.requireDB()
    const settings = new SettingsStore(db)
    const storage = new NotificationStorage(db)

    // ── Collect URL ───────────────────────────────────────────────

    let url = flags.url
    if (!url) {
      const message = 'Webhook URL:'
      const fieldName = 'url'

      if (jsonMode) {
        outputPromptAsJson(
          buildPromptConfig('input', fieldName, message),
          createMetadata('notify setup', flags),
        )
        return
      }

      const answers = await inquirer.prompt([{
        type: 'input',
        name: fieldName,
        message,
        validate: (input: string) => {
          if (!input.trim()) return 'URL is required'
          try {
            new URL(input.trim())
            return true
          } catch {
            return 'Enter a valid URL (e.g., https://example.com/webhook)'
          }
        },
      }])
      url = answers.url as string
    }

    // Validate URL
    try {
      new URL(url)
    } catch {
      if (jsonMode) {
        outputErrorAsJson('INVALID_URL', `Invalid URL: ${url}`, createMetadata('notify setup', flags))
        return
      }
      this.error(`Invalid URL: ${url}`)
    }

    // ── Collect Format ────────────────────────────────────────────

    let format = flags.format as WebhookFormat | undefined
    if (!format) {
      const formatChoices = [
        { name: 'Generic JSON — raw event payload', value: 'generic' },
        { name: 'Slack — Block Kit formatted message', value: 'slack' },
      ]
      const message = 'Payload format:'

      if (jsonMode) {
        outputPromptAsJson(
          buildPromptConfig('list', 'format', message, formatChoices),
          createMetadata('notify setup', flags),
        )
        return
      }

      const answers = await inquirer.prompt([{
        type: 'list',
        name: 'format',
        message,
        choices: formatChoices,
      }])
      format = answers.format as WebhookFormat
    }

    const secret = flags.secret
    const providerName = flags.name || 'webhook'

    // ── Save to workspace_settings ─────────────────────────────────

    settings.set('webhook.url', url)
    settings.set('webhook.enabled', 'true')
    settings.set('webhook.format', format)
    if (secret) {
      settings.set('webhook.secret', secret)
    }

    // ── Create or update webhook provider ──────────────────────────

    const config: WebhookProviderConfig = {
      url,
      format,
      ...(secret ? { secret } : {}),
    }

    const existing = storage.getProviderByName(providerName)
    let providerId: string

    if (existing) {
      storage.updateProvider(existing.id, { config, enabled: true })
      providerId = existing.id
    } else {
      const provider = storage.createProvider({ type: 'webhook', name: providerName, config })
      providerId = provider.id
    }

    // ── Auto-wire agent lifecycle rules ────────────────────────────

    const wiredEvents: string[] = []
    for (const event of AGENT_LIFECYCLE_EVENTS) {
      const existingRules = storage.listRules({ event, providerId })
      if (existingRules.length === 0) {
        storage.createRule({ event, providerId })
        wiredEvents.push(event)
      }
    }

    // ── Test ping ──────────────────────────────────────────────────

    let testResult: { success: boolean; error?: string; durationMs: number } | null = null

    if (!flags['skip-test']) {
      if (!jsonMode) {
        this.log(styles.muted('Sending test ping...'))
      }

      const provider = storage.getProviderById(providerId)!
      const result = await dispatchNotification(provider, {
        event: 'webhook.ping',
        message: 'Webhook configured successfully via prlt notify setup.',
      })

      testResult = { success: result.success, error: result.error, durationMs: result.durationMs }
    }

    // ── Output ─────────────────────────────────────────────────────

    if (jsonMode) {
      outputSuccessAsJson(
        {
          provider: { id: providerId, name: providerName, type: 'webhook' },
          settings: { url, format, hasSecret: !!secret },
          wiredEvents,
          testResult,
        },
        createMetadata('notify setup', flags),
      )
      return
    }

    this.log(styles.success(`Webhook provider "${providerName}" configured`))
    this.log(styles.muted(`  URL:    ${url}`))
    this.log(styles.muted(`  Format: ${format}`))
    if (secret) this.log(styles.muted('  Secret: (configured)'))

    if (wiredEvents.length > 0) {
      this.log(styles.info(`  Auto-wired rules for: ${wiredEvents.join(', ')}`))
    }

    if (testResult) {
      if (testResult.success) {
        this.log(styles.success(`  Test ping: OK (${testResult.durationMs}ms)`))
      } else {
        this.log(styles.warning(`  Test ping failed: ${testResult.error}`))
        this.log(styles.muted('  You can re-test with: prlt notify test webhook'))
      }
    }
  }
}

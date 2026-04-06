/**
 * Notification Layer
 *
 * Outbound notification system for daemon events, hook actions, and escalations.
 *
 * Providers: Slack, Email (SendGrid/SES), SMS (Twilio), Terminal, Browser Push
 * Escalation: Configurable timeout-based escalation chains
 * Storage: Workspace DB (not YAML), shareable across machines
 */

// Types
export {
  type NotificationProviderType,
  type NotificationProvider,
  type NotificationRule,
  type NotificationContext,
  type NotificationResult,
  type ProviderConfig,
  type SlackProviderConfig,
  type EmailProviderConfig,
  type SmsProviderConfig,
  type TerminalProviderConfig,
  type BrowserPushProviderConfig,
  type WebhookProviderConfig,
  type WebhookFormat,
  NOTIFICATION_PROVIDER_TYPES,
  WEBHOOK_FORMATS,
  type NotificationEvent,
  type EscalationStep,
  type ActiveEscalation,
} from './types.js'

// Storage
export { NotificationStorage } from './storage.js'

// Dispatcher
export {
  dispatchNotification,
  dispatchNotifications,
  buildMessage,
  buildWebhookPayload,
} from './dispatcher.js'

// Manager
export {
  NotificationManager,
  type NotificationManagerOptions,
  initNotificationManager,
  getNotificationManager,
  stopNotificationManager,
} from './manager.js'

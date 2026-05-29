import { Flags } from '@oclif/core'
import { PMOCommand, pmoBaseFlags } from '../../lib/pmo/index.js'
import { colors } from '../../lib/colors.js'
import {
  shouldOutputJson,
  outputSuccessAsJson,
  outputErrorAsJson,
  createMetadata,
} from '../../lib/prompt-json.js'
import { listRequirements } from '../../lib/braingrid/client.js'
import { mapRequirementToTicket } from '../../lib/braingrid/mapper.js'
import type { BrainGridRequirement } from '../../lib/braingrid/client.js'

/**
 * Import BrainGrid requirements into Linear as THIN mirror tickets — one ticket
 * per requirement. BrainGrid stays the source of truth (content + task ordering);
 * the executing agent pulls full task specs from BrainGrid at run time.
 */
export default class BraingridImport extends PMOCommand {
  static description = 'Import BrainGrid requirements into Linear as thin mirror tickets (one per requirement)'

  static examples = [
    '<%= config.bin %> <%= command.id %> --braingrid-project PROJ-11 --dry-run   # Preview',
    '<%= config.bin %> <%= command.id %> --braingrid-project PROJ-11             # Import (idempotent)',
    '<%= config.bin %> <%= command.id %> --braingrid-project PROJ-11 --status PLANNED',
  ]

  static flags = {
    ...pmoBaseFlags,
    'braingrid-project': Flags.string({
      description: 'BrainGrid project id to import from (e.g. PROJ-11)',
      required: true,
    }),
    status: Flags.string({
      description: 'Only import requirements with this BrainGrid status (e.g. PLANNED)',
    }),
    requirement: Flags.string({
      description: 'Import only this single BrainGrid requirement (e.g. REQ-3)',
    }),
    'dry-run': Flags.boolean({
      description: 'Preview what would be imported without creating tickets',
      default: false,
    }),
  }

  async execute(): Promise<void> {
    const { flags } = await this.parse(BraingridImport)
    const jsonMode = shouldOutputJson(flags)
    const meta = () => createMetadata('braingrid import', flags)

    // 1. Fetch requirements from the BrainGrid CLI
    let requirements: BrainGridRequirement[]
    try {
      requirements = listRequirements(flags['braingrid-project'])
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to list BrainGrid requirements.'
      if (jsonMode) { outputErrorAsJson('BRAINGRID_FETCH_FAILED', msg, meta()); return }
      this.error(msg)
    }

    if (flags.requirement) {
      requirements = requirements.filter(r => r.short_id === flags.requirement)
    }
    if (flags.status) {
      const want = flags.status.toLowerCase()
      requirements = requirements.filter(r => (r.status || '').toLowerCase() === want)
    }

    if (requirements.length === 0) {
      if (jsonMode) { outputSuccessAsJson({ imported: 0, message: 'No matching requirements found.' }, meta()); return }
      this.log(colors.textMuted('No matching BrainGrid requirements found.'))
      return
    }

    // 2. Resolve the prlt project + Linear provider
    const projectId = await this.requireProject({
      jsonMode: jsonMode ? {
        flags,
        commandName: 'braingrid import',
        baseCommand: `${this.config.bin} braingrid import`,
      } : undefined,
    })
    const provider = this.resolveProjectProvider(projectId, 'linear')

    // 3. Idempotency. Linear derives metadata.external_key as its own issue key,
    //    so we key on the deterministic title prefix "<short_id>:" (round-trips
    //    reliably), with the bg/<key> label and metadata as backups.
    const listResult = await provider.listTickets(projectId)
    const existing = listResult.success ? listResult.tickets : []
    const alreadyImported = (key: string): boolean =>
      existing.some(t =>
        (t.title || '').startsWith(`${key}:`)
        || (t.labels || []).includes(`bg/${key}`)
        || t.metadata?.external_key === key
      )

    const toImport = requirements.filter(r => !alreadyImported(r.short_id))
    const skipped = requirements.length - toImport.length

    // 4. Dry run
    if (flags['dry-run']) {
      const wouldImport = toImport.map(r => ({ id: r.short_id, name: r.name, url: r.url }))
      if (jsonMode) { outputSuccessAsJson({ dryRun: true, wouldImport, skipped }, meta()); return }
      this.log('')
      this.log(colors.primary(`Dry run — would create ${toImport.length} Linear ticket(s):`))
      for (const r of toImport) this.log(`  ${colors.textSecondary(r.short_id)}  ${r.name}`)
      if (skipped > 0) this.log(colors.textMuted(`  (${skipped} already imported, skipped)`))
      return
    }

    // 5. Create (create-only — never clobber tickets a human may have enriched in Linear)
    this.log(colors.textMuted(`Importing ${toImport.length} requirement(s) into Linear...`))
    let imported = 0
    const errors: Array<{ id: string; error: string }> = []
    const created: Array<{ id: string; ticket?: string }> = []

    for (const req of toImport) {
      try {
        const result = await provider.createTicket(projectId, mapRequirementToTicket(req))
        if (!result.success) throw new Error(result.error || 'Create failed')
        imported++
        created.push({ id: req.short_id, ticket: result.ticket?.metadata?.external_key || result.ticket?.id })
      } catch (error: unknown) {
        errors.push({ id: req.short_id, error: error instanceof Error ? error.message : 'Unknown error' })
      }
    }

    if (jsonMode) { outputSuccessAsJson({ imported, skipped, created, errors }, meta()); return }
    if (imported > 0) this.log(colors.success(`Imported ${imported} requirement(s) into Linear`))
    if (skipped > 0) this.log(colors.textMuted(`  Skipped ${skipped} (already imported)`))
    if (errors.length > 0) {
      this.log(colors.error(`  ${errors.length} error(s):`))
      for (const e of errors) this.log(colors.textMuted(`    ${e.id}: ${e.error}`))
    }
  }
}

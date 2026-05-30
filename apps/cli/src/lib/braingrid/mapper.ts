import type { BrainGridRequirement } from './client.js'
import type { CreateTicketInput } from '../pmo/types.js'

/**
 * Map a BrainGrid requirement to a THIN Linear ticket (one ticket per requirement).
 *
 * Deliberately a mirror, not a copy: BrainGrid is the source of truth. The body
 * carries the BrainGrid id + URL and tells the executing agent to pull the full
 * task specs (and their ordering) from BrainGrid at run time. We never duplicate
 * the spec content here — that's what caused churn in the legacy system.
 */
export function mapRequirementToTicket(req: BrainGridRequirement): CreateTicketInput {
  const key = req.short_id
  const taskCount = req.task_progress?.total

  const description = [
    `Thin mirror of BrainGrid requirement **${key}** — BrainGrid is the source of truth.`,
    '',
    `**BrainGrid:** ${req.url}`,
    taskCount == null ? '' : `**Tasks:** ${taskCount} (defined in BrainGrid)`,
    '',
    'Implement the tasks defined in BrainGrid, in the order BrainGrid specifies',
    '(each task states its `Depends on` / `Can parallelize with`). Pull the full',
    'specs at run time — do not duplicate them here:',
    '',
    '```',
    `braingrid task list --requirement ${key} --format markdown`,
    '```',
    '',
    '## Definition of done (QA-ready)',
    '- If this adds or changes UI, **wire it into a reachable route** (or a `/dev/...` test route). An orphaned component cannot be human-tested.',
    '- In the **PR body, include a test plan**: what to verify, how to reach it in the running app, and what a passing result looks like.',
    '- Apply any new DB migrations against local Supabase.',
  ].filter(Boolean).join('\n')

  return {
    title: `${key}: ${req.name}`,
    description,
    labels: ['source/braingrid', `bg/${key}`],
    metadata: {
      external_source: 'braingrid',
      external_key: key,
      external_url: req.url,
    },
  }
}

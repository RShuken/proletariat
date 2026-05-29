import { execFileSync } from 'node:child_process'

/**
 * A BrainGrid requirement as returned by `braingrid requirement list --format json`.
 * Verified against PROJ-11 on 2026-05-29 (CLI v0.2.67).
 */
export interface BrainGridRequirement {
  /** UUID */
  id: string
  /** Human id, e.g. "REQ-12" — this is the stable key we mirror into Linear */
  short_id: string
  name: string
  status?: string
  url: string
  task_progress?: {
    total: number
    completed: number
    progress_percentage: number
  }
}

/**
 * Extract the first complete JSON value (object or array) from noisy text.
 *
 * The BrainGrid CLI prints spinner characters before, and an "update available"
 * notice after, the JSON payload. We scan for the first `{`/`[` and track bracket
 * depth (string-aware) to slice out exactly one complete JSON value.
 */
export function extractFirstJson<T = unknown>(text: string): T {
  const start = text.search(/[[{]/)
  if (start === -1) throw new Error(`braingrid: no JSON found in output:\n${text}`)

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) { escaped = false; continue }
    if (inString) {
      if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return JSON.parse(text.slice(start, i + 1)) as T
    }
  }
  throw new Error(`braingrid: unterminated JSON in output:\n${text}`)
}

/**
 * Run `braingrid <args> --format json` (no shell), strip noise, return parsed JSON.
 * Throws if the CLI exits non-zero (e.g. not authenticated).
 */
export function runBrainGridJson<T = unknown>(args: string[]): T {
  let raw: string
  try {
    raw = execFileSync('braingrid', [...args, '--format', 'json'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (error: unknown) {
    const stderr = (error as { stderr?: Buffer })?.stderr?.toString().trim()
    const msg = (error as Error)?.message ?? 'braingrid CLI failed'
    throw new Error(stderr ? `braingrid CLI failed: ${stderr}` : msg)
  }
  return extractFirstJson<T>(raw)
}

/**
 * List requirements for a BrainGrid project (e.g. "PROJ-11").
 * `requirement list --format json` returns `{ requirements: [...] }`.
 */
export function listRequirements(braingridProject: string): BrainGridRequirement[] {
  const out = runBrainGridJson<{ requirements?: BrainGridRequirement[] } | BrainGridRequirement[]>(
    ['requirement', 'list', '-p', braingridProject]
  )
  if (Array.isArray(out)) return out
  return out.requirements ?? []
}

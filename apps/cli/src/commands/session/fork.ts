import { Args, Flags } from '@oclif/core'
import { execSync, execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { styles } from '../../lib/styles.js'
import { getWorkspaceInfo } from '../../lib/agents/commands.js'
import { openWorkspaceDatabase } from '../../lib/database/index.js'
import { ExecutionStorage } from '../../lib/execution/storage.js'
import { findSessionLogPath } from '../../lib/execution/token-parser.js'
import {
  getHostTmuxSessionNames,
  findSessionForExecution,
  buildExpectedSessionName,
  captureTmuxPane,
} from '../../lib/execution/session-utils.js'
import { PromptCommand } from '../../lib/prompt-command.js'
import { machineOutputFlags } from '../../lib/pmo/index.js'
import {
  shouldOutputJson,
  outputSuccessAsJson,
  outputErrorAsJson,
  createMetadata,
} from '../../lib/prompt-json.js'
import type { AgentWork } from '../../lib/execution/types.js'

export default class SessionFork extends PromptCommand {
  static description = 'Fork an agent session to a new branch with conversation history'

  static examples = [
    '<%= config.bin %> <%= command.id %> my-agent',
    '<%= config.bin %> <%= command.id %> my-agent --new-name my-agent-v2',
    '<%= config.bin %> <%= command.id %> my-agent --branch feat/experiment',
  ]

  static args = {
    agent_name: Args.string({
      description: 'Name of the agent whose session to fork',
      required: true,
    }),
  }

  static flags = {
    ...machineOutputFlags,
    'new-name': Flags.string({
      description: 'Name for the forked agent session',
    }),
    branch: Flags.string({
      char: 'b',
      description: 'Branch name for the new worktree (default: auto-generated)',
    }),
  }

  protected getPMOOptions() {
    return { promptIfMultiple: false }
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SessionFork)
    const jsonMode = shouldOutputJson(flags)
    const sourceAgentName = args.agent_name

    // Open workspace database
    let workspaceInfo: ReturnType<typeof getWorkspaceInfo>
    let executionStorage: ExecutionStorage
    try {
      workspaceInfo = getWorkspaceInfo()
      const db = openWorkspaceDatabase(workspaceInfo.path)
      executionStorage = new ExecutionStorage(db)
    } catch {
      const msg = 'Not in a prlt workspace. Run from a workspace directory.'
      if (jsonMode) {
        outputErrorAsJson('NOT_IN_WORKSPACE', msg, createMetadata('session fork', flags))
        return
      }
      this.error(msg)
      return
    }

    // Find running execution for the source agent
    const executions = executionStorage.getAgentRunningExecutions(sourceAgentName)
    if (executions.length === 0) {
      const msg = `No running execution found for agent "${sourceAgentName}".`
      if (jsonMode) {
        outputErrorAsJson('NO_EXECUTION', msg, createMetadata('session fork', flags))
        return
      }
      this.error(msg)
      return
    }

    const sourceExec = executions[0]

    // Find the tmux session for the source agent
    const hostSessions = getHostTmuxSessionNames()
    const sourceSession = sourceExec.sessionId
      ? (hostSessions.includes(sourceExec.sessionId) ? sourceExec.sessionId : null)
      : findSessionForExecution(sourceExec.ticketId, sourceAgentName, hostSessions)

    if (!sourceSession) {
      const msg = `Cannot find tmux session for agent "${sourceAgentName}".`
      if (jsonMode) {
        outputErrorAsJson('NO_SESSION', msg, createMetadata('session fork', flags))
        return
      }
      this.error(msg)
      return
    }

    // Find the source worktree path
    const sourceWorktreePath = resolveSourceWorktreePath(sourceExec, workspaceInfo.path)
    if (!sourceWorktreePath || !fs.existsSync(sourceWorktreePath)) {
      const msg = `Cannot find worktree for agent "${sourceAgentName}".`
      if (jsonMode) {
        outputErrorAsJson('NO_WORKTREE', msg, createMetadata('session fork', flags))
        return
      }
      this.error(msg)
      return
    }

    // Find the Claude Code JSONL log
    const jsonlPath = findClaudeSessionLog(sourceSession, sourceWorktreePath)
    if (!jsonlPath) {
      const msg = `Cannot find Claude Code session log for agent "${sourceAgentName}". The agent may not have started a Claude Code session yet.`
      if (jsonMode) {
        outputErrorAsJson('NO_SESSION_LOG', msg, createMetadata('session fork', flags))
        return
      }
      this.error(msg)
      return
    }

    // Determine names
    const forkName = flags['new-name'] || `${sourceAgentName}-fork`
    const sourceBranch = getCurrentBranch(sourceWorktreePath)
    const forkBranch = flags.branch || `${sourceBranch}-fork-${Date.now()}`

    // Verify the fork name isn't already in use
    const existingExecs = executionStorage.getAgentRunningExecutions(forkName)
    if (existingExecs.length > 0) {
      const msg = `Agent "${forkName}" already has a running execution. Use --new-name to specify a different name.`
      if (jsonMode) {
        outputErrorAsJson('NAME_CONFLICT', msg, createMetadata('session fork', flags))
        return
      }
      this.error(msg)
      return
    }

    if (!jsonMode) {
      this.log('')
      this.log(styles.info(`Forking agent "${sourceAgentName}" → "${forkName}"`))
      this.log(styles.muted(`  Source branch: ${sourceBranch}`))
      this.log(styles.muted(`  Fork branch:   ${forkBranch}`))
      this.log('')
    }

    // Step 1: Create new git worktree on a new branch
    const forkWorktreePath = path.join(workspaceInfo.path, 'agents', 'temp', forkName)
    try {
      fs.mkdirSync(path.dirname(forkWorktreePath), { recursive: true })
      execFileSync('git', [
        'worktree', 'add', forkWorktreePath, '-b', forkBranch, 'HEAD',
      ], { cwd: sourceWorktreePath, stdio: 'pipe' })
    } catch (error) {
      const msg = `Failed to create worktree: ${error instanceof Error ? error.message : error}`
      if (jsonMode) {
        outputErrorAsJson('WORKTREE_FAILED', msg, createMetadata('session fork', flags))
        return
      }
      this.error(msg)
      return
    }

    // Step 2: Copy the Claude Code JSONL to the new worktree's project dir
    const newJsonlPath = copySessionLog(jsonlPath, forkWorktreePath)

    // Step 3: Create new tmux session with Claude Code --resume
    const forkSessionName = buildExpectedSessionName(sourceExec.ticketId, forkName, 'work')

    // Check session name not already taken
    const activeSessions = getHostTmuxSessionNames()
    if (activeSessions.includes(forkSessionName)) {
      const msg = `Tmux session "${forkSessionName}" already exists. Use --new-name to specify a different name.`
      if (jsonMode) {
        outputErrorAsJson('SESSION_EXISTS', msg, createMetadata('session fork', flags))
        return
      }
      this.error(msg)
      return
    }

    // Build claude command for the forked session
    let claudeCmd = 'claude --resume'
    if (sourceExec.permissionMode === 'danger') {
      claudeCmd += ' --dangerously-skip-permissions'
    }

    try {
      execFileSync('tmux', [
        'new-session', '-d',
        '-s', forkSessionName,
        '-c', forkWorktreePath,
        `bash -c 'cd "${forkWorktreePath}" && ${claudeCmd}; exec $SHELL'`,
      ], { stdio: 'pipe' })
    } catch (error) {
      const msg = `Failed to create tmux session: ${error instanceof Error ? error.message : error}`
      if (jsonMode) {
        outputErrorAsJson('TMUX_FAILED', msg, createMetadata('session fork', flags))
        return
      }
      this.error(msg)
      return
    }

    // Step 4: Register forked execution in database
    const forkedExec = executionStorage.createExecution({
      ticketId: sourceExec.ticketId,
      agentName: forkName,
      executor: sourceExec.executor,
      environment: sourceExec.environment,
      displayMode: sourceExec.displayMode,
      permissionMode: sourceExec.permissionMode,
      cleanupPolicy: sourceExec.cleanupPolicy,
      branch: forkBranch,
      sessionId: forkSessionName,
      externalSource: sourceExec.externalSource,
      externalKey: sourceExec.externalKey,
      externalId: sourceExec.externalId,
      externalUrl: sourceExec.externalUrl,
    })

    // Update status to running
    executionStorage.updateStatus(forkedExec.id, 'running')

    if (jsonMode) {
      outputSuccessAsJson({
        forkedExecution: {
          id: forkedExec.id,
          agentName: forkName,
          ticketId: sourceExec.ticketId,
          branch: forkBranch,
          sessionId: forkSessionName,
          worktreePath: forkWorktreePath,
          sourceAgentName: sourceAgentName,
          sourceExecutionId: sourceExec.id,
        },
        sessionLog: {
          source: jsonlPath,
          destination: newJsonlPath,
        },
      }, createMetadata('session fork', flags))
      return
    }

    this.log(styles.success('Session forked successfully!'))
    this.log('')
    this.log(`  ${styles.muted('Execution:')}  ${forkedExec.id}`)
    this.log(`  ${styles.muted('Agent:')}      ${forkName}`)
    this.log(`  ${styles.muted('Branch:')}     ${forkBranch}`)
    this.log(`  ${styles.muted('Session:')}    ${forkSessionName}`)
    this.log(`  ${styles.muted('Worktree:')}   ${forkWorktreePath}`)
    this.log('')
    this.log(styles.muted(`Attach with: prlt session attach ${forkSessionName}`))
    this.log('')
  }
}

// =============================================================================
// Helpers (exported for testing)
// =============================================================================

/**
 * Resolve the worktree path for a source execution.
 * Checks the agent's temp directory first, then searches git worktree list.
 */
export function resolveSourceWorktreePath(exec: AgentWork, workspacePath: string): string | null {
  // Try the standard agent temp directory
  const agentDir = path.join(workspacePath, 'agents', 'temp', exec.agentName)
  if (fs.existsSync(agentDir)) return agentDir

  // Try finding via git worktree list if we have a branch
  if (exec.branch) {
    try {
      const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: workspacePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      for (const block of output.split('\n\n')) {
        if (block.includes(`branch refs/heads/${exec.branch}`)) {
          const match = block.match(/^worktree (.+)$/m)
          if (match) return match[1]
        }
      }
    } catch {
      // Fall through
    }
  }

  return null
}

/**
 * Get the current git branch of a directory.
 */
export function getCurrentBranch(dir: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

/**
 * Find the Claude Code JSONL session log for a tmux session.
 *
 * Claude Code stores logs at ~/.claude/projects/-{cwd-with-dashes}/{sessionId}.jsonl
 * We search the project directory for the most recent JSONL file matching the worktree.
 */
export function findClaudeSessionLog(sessionName: string, worktreePath: string): string | null {
  // First try: use findSessionLogPath with the session name directly
  const directMatch = findSessionLogPath(sessionName, worktreePath)
  if (directMatch) return directMatch

  // Second try: search for JSONL files in the project directory matching the worktree
  const claudeDir = path.join(os.homedir(), '.claude', 'projects')
  if (!fs.existsSync(claudeDir)) return null

  // Claude Code encodes the cwd as: '-' + path.replace(/\//g, '-')
  const projectDirName = '-' + worktreePath.replace(/\//g, '-')
  const projectDir = path.join(claudeDir, projectDirName)

  if (!fs.existsSync(projectDir)) return null

  // Find the most recently modified JSONL file in this project dir
  try {
    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        path: path.join(projectDir, f),
        mtime: fs.statSync(path.join(projectDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)

    return files.length > 0 ? files[0].path : null
  } catch {
    return null
  }
}

/**
 * Copy a Claude Code JSONL session log to a new worktree's project directory.
 * Returns the destination path.
 *
 * The JSONL is copied (not moved) so the source session's history is preserved.
 * The file is placed in ~/.claude/projects/-{new-worktree-path}/ so Claude Code
 * picks it up with --resume.
 */
export function copySessionLog(sourcePath: string, newWorktreePath: string): string {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects')
  const projectDirName = '-' + newWorktreePath.replace(/\//g, '-')
  const destDir = path.join(claudeDir, projectDirName)

  fs.mkdirSync(destDir, { recursive: true })

  // Keep the same filename (session ID) so --resume can find it
  const fileName = path.basename(sourcePath)
  const destPath = path.join(destDir, fileName)

  fs.copyFileSync(sourcePath, destPath)

  return destPath
}

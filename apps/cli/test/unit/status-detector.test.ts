/* eslint-disable max-nested-callbacks */
import { expect } from 'chai'
import {
  classifyStatus,
  stripAnsi,
  toDashboardStatus,
  toNotificationEvent,
  type SessionStatus,
  DEFAULT_DETECTOR_CONFIG,
} from '../../src/lib/execution/status-detector.js'

describe('Status Detector (TKT-031)', () => {
  // =====================================================================
  // ANSI Stripping
  // =====================================================================
  describe('stripAnsi', () => {
    it('should strip CSI color codes', () => {
      expect(stripAnsi('\x1B[31mError\x1B[0m')).to.equal('Error')
    })

    it('should strip bold/underline codes', () => {
      expect(stripAnsi('\x1B[1m\x1B[4mBold Underline\x1B[0m')).to.equal('Bold Underline')
    })

    it('should strip OSC sequences (terminal title)', () => {
      expect(stripAnsi('\x1B]0;My Title\x07some text')).to.equal('some text')
    })

    it('should strip cursor movement codes', () => {
      expect(stripAnsi('\x1B[2J\x1B[HHello')).to.equal('Hello')
    })

    it('should preserve normal text', () => {
      expect(stripAnsi('Hello World')).to.equal('Hello World')
    })

    it('should handle empty string', () => {
      expect(stripAnsi('')).to.equal('')
    })

    it('should strip control characters but keep tabs and newlines', () => {
      expect(stripAnsi('line1\nline2\ttab')).to.equal('line1\nline2\ttab')
    })

    it('should handle multiple ANSI codes in sequence', () => {
      expect(stripAnsi('\x1B[32m\x1B[1mGreen Bold\x1B[0m Normal')).to.equal('Green Bold Normal')
    })
  })

  // =====================================================================
  // classifyStatus — WORKING detection
  // =====================================================================
  describe('WORKING status', () => {
    it('should detect Read tool use', () => {
      const pane = [
        '⏺ Reading file src/index.ts',
        '  Read(file_path: "/workspace/src/index.ts")',
        '',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('WORKING')
    })

    it('should detect Write tool use', () => {
      const pane = [
        '⏺ Writing to file',
        '  Write(file_path: "/workspace/output.ts")',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('WORKING')
    })

    it('should detect Edit tool use', () => {
      const pane = [
        '⏺ Editing file',
        '  Edit(file_path: "/workspace/lib/utils.ts")',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('WORKING')
    })

    it('should detect Bash tool use', () => {
      const pane = [
        '  Bash(command: "pnpm test")',
        '  Running tests...',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('WORKING')
    })

    it('should detect Grep tool use', () => {
      const pane = [
        '  Grep(pattern: "import.*React")',
        '  Found 5 matches',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('WORKING')
    })

    it('should detect Glob tool use', () => {
      const pane = [
        '  Glob(pattern: "**/*.ts")',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('WORKING')
    })

    it('should detect "esc to interrupt" pattern', () => {
      const pane = [
        '⏺ I\'ll now implement the feature.',
        '',
        '  esc to interrupt',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('WORKING')
    })

    it('should detect active streaming with token counter', () => {
      const pane = [
        '  Processing request...',
        '  tokens│ 1,234',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('WORKING')
    })

    it('should detect shell command execution', () => {
      const pane = [
        '  $ pnpm run build',
        '  Building packages...',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('WORKING')
    })

    it('should detect "⏺ Reading" pattern', () => {
      const pane = [
        '⏺ Reading file contents to understand the structure',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('WORKING')
    })

    it('should detect "⏺ Running" pattern', () => {
      const pane = '⏺ Running the test suite'
      expect(classifyStatus(pane).status).to.equal('WORKING')
    })

    it('should detect "⏺ Searching" pattern', () => {
      const pane = '⏺ Searching for references to the function'
      expect(classifyStatus(pane).status).to.equal('WORKING')
    })
  })

  // =====================================================================
  // classifyStatus — NEEDS_INPUT detection
  // =====================================================================
  describe('NEEDS_INPUT status', () => {
    it('should detect "Allow" permission prompt', () => {
      const pane = [
        '  The agent wants to run a command.',
        '  Allow this tool call?',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('NEEDS_INPUT')
    })

    it('should detect "Approve" prompt', () => {
      const pane = [
        '  File modification requested.',
        '  Approve',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('NEEDS_INPUT')
    })

    it('should detect (y/n) prompt', () => {
      const pane = [
        '  Save changes? (y/n)',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('NEEDS_INPUT')
    })

    it('should detect (Y/n) prompt', () => {
      const pane = [
        '  Continue with installation? (Y/n)',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('NEEDS_INPUT')
    })

    it('should detect (yes/no) prompt', () => {
      const pane = [
        '  Overwrite existing file? (yes/no)',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('NEEDS_INPUT')
    })

    it('should detect "Do you want to proceed?" prompt', () => {
      const pane = [
        '  Changes detected.',
        '  Do you want to proceed?',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('NEEDS_INPUT')
    })

    it('should detect "allow or deny" tool prompt', () => {
      const pane = [
        '  allow or deny this tool call',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('NEEDS_INPUT')
    })

    it('should detect "Yes" / "No" choice list', () => {
      const pane = [
        '  Select an option:',
        '  Yes',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('NEEDS_INPUT')
    })

    it('should detect "waiting for input" message', () => {
      const pane = 'waiting for input from user'
      expect(classifyStatus(pane).status).to.equal('NEEDS_INPUT')
    })

    it('should detect "permission is required" message', () => {
      const pane = 'your permission is required to continue'
      expect(classifyStatus(pane).status).to.equal('NEEDS_INPUT')
    })

    it('should prioritize NEEDS_INPUT over WORKING', () => {
      const pane = [
        '  esc to interrupt',
        '  Allow this tool call?',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('NEEDS_INPUT')
    })
  })

  // =====================================================================
  // classifyStatus — ERROR detection
  // =====================================================================
  describe('ERROR status', () => {
    it('should detect "Error:" prefix', () => {
      const pane = [
        '  Some output',
        '  More output',
        '  Error: Cannot find module',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('ERROR')
    })

    it('should detect FAIL in test output', () => {
      const pane = [
        '  Running tests...',
        '  3 passing',
        '  1 FAIL',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('ERROR')
    })

    it('should detect FAILED', () => {
      const pane = [
        '  Some output',
        '  Build FAILED',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('ERROR')
    })

    it('should detect "crashed"', () => {
      const pane = [
        '  Agent process crashed',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('ERROR')
    })

    it('should detect ENOENT', () => {
      const pane = [
        '  ENOENT: no such file or directory',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('ERROR')
    })

    it('should detect EACCES', () => {
      const pane = [
        '  EACCES: permission denied, open /root/.ssh/id_rsa',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('ERROR')
    })

    it('should detect ECONNREFUSED', () => {
      const pane = [
        '  ECONNREFUSED: Connection refused',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('ERROR')
    })

    it('should detect "fatal error"', () => {
      const pane = [
        '  fatal error: out of memory',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('ERROR')
    })

    it('should detect "Segmentation fault"', () => {
      const pane = [
        '  Segmentation fault (core dumped)',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('ERROR')
    })

    it('should detect "UnhandledException"', () => {
      const pane = [
        '  UnhandledException: unexpected error',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('ERROR')
    })

    it('should detect "command not found"', () => {
      const pane = [
        '  zsh: command not found: foobar',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('ERROR')
    })

    it('should detect non-zero exit codes', () => {
      const pane = [
        '  EXIT 1',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('ERROR')
    })

    it('should only check recent lines for errors (not old scrollback)', () => {
      const lines = ['Error: old error from earlier']
      // Add enough lines to push the error out of the last 5 lines
      for (let i = 0; i < 20; i++) {
        lines.push(`Normal output line ${i}`)
      }
      // Error is in first line, well beyond the recent 5-line window
      expect(classifyStatus(lines.join('\n')).status).to.not.equal('ERROR')
    })

    it('should prioritize NEEDS_INPUT over ERROR', () => {
      const pane = [
        '  Error: something went wrong',
        '  Allow retry?',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('NEEDS_INPUT')
    })
  })

  // =====================================================================
  // classifyStatus — COMPLETE detection
  // =====================================================================
  describe('COMPLETE status', () => {
    it('should detect "agent work complete"', () => {
      const pane = [
        '  All changes committed.',
        '  Agent work complete',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('COMPLETE')
    })

    it('should detect "work ready"', () => {
      const pane = [
        '  PR #42 created.',
        '  Work ready for review.',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('COMPLETE')
    })

    it('should detect "task completed"', () => {
      const pane = [
        '  Implementation is done.',
        '  Task completed successfully.',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('COMPLETE')
    })

    it('should detect "all tasks done"', () => {
      const pane = 'All tasks done'
      expect(classifyStatus(pane).status).to.equal('COMPLETE')
    })

    it('should detect "PR created"', () => {
      const pane = [
        '  PR created for review',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('COMPLETE')
    })

    it('should detect "committed and pushed"', () => {
      const pane = 'Changes committed and pushed to remote'
      expect(classifyStatus(pane).status).to.equal('COMPLETE')
    })

    it('should detect case-insensitively', () => {
      const pane = 'AGENT WORK COMPLETE'
      expect(classifyStatus(pane).status).to.equal('COMPLETE')
    })
  })

  // =====================================================================
  // classifyStatus — IDLE detection
  // =====================================================================
  describe('IDLE status', () => {
    it('should detect shell prompt ($)', () => {
      const pane = [
        '  Last command output',
        'user@host:~/workspace$',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('IDLE')
    })

    it('should detect zsh prompt (❯)', () => {
      const pane = [
        '  Output from last command',
        '~/workspace ❯',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('IDLE')
    })

    it('should detect root prompt (#)', () => {
      const pane = [
        'root@container:/workspace#',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('IDLE')
    })

    it('should detect prompt with trailing whitespace', () => {
      const pane = [
        'user@host:~$ ',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('IDLE')
    })

    it('should detect bare $ prompt', () => {
      const pane = [
        'some output',
        '  $  ',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('IDLE')
    })

    it('should detect bare ❯ prompt', () => {
      const pane = [
        'some output',
        ' ❯ ',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('IDLE')
    })

    it('should detect prompt ignoring trailing empty lines', () => {
      const pane = [
        'user@host:~$',
        '',
        '',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('IDLE')
    })
  })

  // =====================================================================
  // classifyStatus — UNKNOWN detection
  // =====================================================================
  describe('UNKNOWN status', () => {
    it('should return UNKNOWN for null content', () => {
      expect(classifyStatus(null).status).to.equal('UNKNOWN')
    })

    it('should return UNKNOWN for empty string', () => {
      expect(classifyStatus('').status).to.equal('UNKNOWN')
    })

    it('should return UNKNOWN for whitespace-only', () => {
      expect(classifyStatus('   \n  \n  ').status).to.equal('UNKNOWN')
    })

    it('should return UNKNOWN for unrecognized output', () => {
      const pane = [
        'some generic text',
        'that does not match any known pattern',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('UNKNOWN')
    })
  })

  // =====================================================================
  // classifyStatus — ANSI handling
  // =====================================================================
  describe('ANSI handling', () => {
    it('should detect WORKING through ANSI-wrapped output', () => {
      const pane = '\x1B[32m⏺ Reading\x1B[0m file src/index.ts'
      expect(classifyStatus(pane).status).to.equal('WORKING')
    })

    it('should detect ERROR through ANSI-wrapped output', () => {
      const pane = '\x1B[31mError: Cannot find module "foo"\x1B[0m'
      expect(classifyStatus(pane).status).to.equal('ERROR')
    })

    it('should detect NEEDS_INPUT through ANSI-wrapped output', () => {
      const pane = '\x1B[33mAllow this tool call?\x1B[0m'
      expect(classifyStatus(pane).status).to.equal('NEEDS_INPUT')
    })

    it('should detect COMPLETE through ANSI-wrapped output', () => {
      const pane = '\x1B[32mAgent work complete\x1B[0m'
      expect(classifyStatus(pane).status).to.equal('COMPLETE')
    })
  })

  // =====================================================================
  // Priority ordering
  // =====================================================================
  describe('priority ordering', () => {
    it('should prioritize NEEDS_INPUT over everything', () => {
      const pane = [
        '  esc to interrupt',
        '  Error: something broke',
        '  Allow retry?',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('NEEDS_INPUT')
    })

    it('should prioritize ERROR over COMPLETE', () => {
      const pane = [
        '  Task completed',
        '  Error: post-commit hook failed',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('ERROR')
    })

    it('should prioritize ERROR over WORKING', () => {
      const pane = [
        '  esc to interrupt',
        '  FAIL: test suite failed',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('ERROR')
    })

    it('should prioritize COMPLETE over WORKING when both present', () => {
      // If both completion and tool patterns are in the last lines,
      // COMPLETE should win (tool use happened before completion)
      const pane = [
        '  Read(file_path: "...")',
        '  Task completed successfully.',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('COMPLETE')
    })

    it('should prioritize WORKING over IDLE', () => {
      const pane = [
        '  $ pnpm test',
        '  Running tests...',
        'user@host:~$',
      ].join('\n')
      // The $ prompt is last, but the tool use in recent lines should win
      // Actually in this case IDLE wins because it checks last non-empty line
      // The WORKING patterns check the tail window, so both match —
      // but WORKING is checked before IDLE
      expect(classifyStatus(pane).status).to.equal('WORKING')
    })
  })

  // =====================================================================
  // Realistic Claude Code output samples
  // =====================================================================
  describe('realistic Claude Code output', () => {
    it('should detect WORKING from active file editing session', () => {
      const pane = [
        '⏺ I\'ll now implement the authentication middleware.',
        '',
        '  Let me first read the existing auth handler to understand the pattern.',
        '',
        '⏺ Reading file src/middleware/auth.ts',
        '',
        '  Read(file_path: "/workspace/src/middleware/auth.ts")',
        '',
        '  1 | import { NextRequest } from \'next/server\'',
        '  2 | import { verifyToken } from \'../lib/jwt\'',
        '  ...',
        '',
        '  esc to interrupt',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('WORKING')
    })

    it('should detect NEEDS_INPUT from Claude Code permission prompt', () => {
      const pane = [
        '⏺ I\'ll run the database migration.',
        '',
        '  Bash(command: "pnpm db:migrate")',
        '',
        '  This will execute a bash command.',
        '  Allow this tool call?',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('NEEDS_INPUT')
    })

    it('should detect ERROR from failed test run', () => {
      const pane = [
        '  $ pnpm test',
        '',
        '  PASS src/utils.test.ts',
        '  FAIL src/auth.test.ts',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('ERROR')
    })

    it('should detect ERROR from build failure', () => {
      const pane = [
        '  $ pnpm build',
        '  Building TypeScript...',
        '  Error: TS2345: Argument of type \'string\' is not assignable',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('ERROR')
    })

    it('should detect COMPLETE from finished agent work', () => {
      const pane = [
        '⏺ All changes have been committed and the PR has been created.',
        '',
        '  Summary:',
        '  - Added authentication middleware',
        '  - Updated 3 route handlers',
        '  - Added unit tests (12 passing)',
        '',
        '  Agent work complete',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('COMPLETE')
    })

    it('should detect IDLE from returned shell prompt after agent exits', () => {
      const pane = [
        '  Agent exited with code 0.',
        '  Session ended.',
        '',
        'user@machine:~/workspace$',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('IDLE')
    })

    it('should detect WORKING from agent using Search/WebFetch', () => {
      const pane = [
        '  WebFetch(url: "https://api.example.com")',
        '  Fetching response...',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('WORKING')
    })

    it('should detect WORKING from TodoWrite tool', () => {
      const pane = [
        '  TodoWrite(todos: [...])',
        '  Updated task list.',
      ].join('\n')
      expect(classifyStatus(pane).status).to.equal('WORKING')
    })
  })

  // =====================================================================
  // Edge cases
  // =====================================================================
  describe('edge cases', () => {
    it('should handle very long pane content', () => {
      const lines = Array.from({ length: 200 }, (_, i) => `Output line ${i}`)
      lines.push('  esc to interrupt')
      expect(classifyStatus(lines.join('\n')).status).to.equal('WORKING')
    })

    it('should only analyze last N lines (configurable)', () => {
      const lines = ['Error: old error']
      for (let i = 0; i < 50; i++) {
        lines.push(`Normal output line ${i}`)
      }
      // Error is in first line, should be outside the analyze window
      expect(classifyStatus(lines.join('\n')).status).to.not.equal('ERROR')
    })

    it('should respect custom analyzeLines config', () => {
      const lines = ['  esc to interrupt']
      for (let i = 0; i < 5; i++) {
        lines.push(`Normal output line ${i}`)
      }
      // With analyzeLines=3, only last 3 lines are checked
      const result = classifyStatus(lines.join('\n'), { ...DEFAULT_DETECTOR_CONFIG, analyzeLines: 3 })
      expect(result.status).to.not.equal('WORKING')
    })

    it('should include matchedPattern in result', () => {
      const pane = 'Error: something broke'
      const result = classifyStatus(pane)
      expect(result.matchedPattern).to.be.a('string')
      expect(result.matchedPattern!.length).to.be.greaterThan(0)
    })

    it('should include detectedAt timestamp', () => {
      const before = new Date()
      const result = classifyStatus('some text')
      expect(result.detectedAt.getTime()).to.be.at.least(before.getTime())
    })

    it('should include rawOutput (stripped) in result', () => {
      const pane = '\x1B[31mHello\x1B[0m'
      const result = classifyStatus(pane)
      expect(result.rawOutput).to.equal('Hello')
    })
  })

  // =====================================================================
  // toDashboardStatus mapping
  // =====================================================================
  describe('toDashboardStatus', () => {
    const cases: Array<[SessionStatus, string]> = [
      ['WORKING', 'working'],
      ['NEEDS_INPUT', 'needs-input'],
      ['ERROR', 'error'],
      ['COMPLETE', 'idle'],
      ['IDLE', 'idle'],
      ['UNKNOWN', 'idle'],
    ]

    for (const [input, expected] of cases) {
      it(`should map ${input} to ${expected}`, () => {
        expect(toDashboardStatus(input)).to.equal(expected)
      })
    }
  })

  // =====================================================================
  // toNotificationEvent mapping
  // =====================================================================
  describe('toNotificationEvent', () => {
    it('should map NEEDS_INPUT to on_agent_needs_input', () => {
      expect(toNotificationEvent('NEEDS_INPUT')).to.equal('on_agent_needs_input')
    })

    it('should map ERROR to on_agent_died', () => {
      expect(toNotificationEvent('ERROR')).to.equal('on_agent_died')
    })

    it('should map COMPLETE to on_agent_completed', () => {
      expect(toNotificationEvent('COMPLETE')).to.equal('on_agent_completed')
    })

    it('should return null for WORKING', () => {
      expect(toNotificationEvent('WORKING')).to.equal(null)
    })

    it('should return null for IDLE', () => {
      expect(toNotificationEvent('IDLE')).to.equal(null)
    })

    it('should return null for UNKNOWN', () => {
      expect(toNotificationEvent('UNKNOWN')).to.equal(null)
    })
  })
})

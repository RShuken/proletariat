import { expect } from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  AutoResponder,
  classifyPrompt,
  AUTO_RESPOND_COOLDOWN_MS,
} from '../../src/lib/orchestrate/auto-responder.js'
import type {
  AutoResponderDeps,
  SessionInfo,
  PromptCategory,
} from '../../src/lib/orchestrate/auto-responder.js'

// =============================================================================
// Test Helpers
// =============================================================================

function fakeDeps(overrides: Partial<AutoResponderDeps> = {}): AutoResponderDeps {
  return {
    captureTmuxPane: () => null,
    sendTmuxMessage: () => {},
    ...overrides,
  }
}

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    executionId: 'WORK-TEST1',
    sessionId: 'prlt-session-test1',
    agentName: 'test-agent',
    ticketId: 'TKT-027',
    permissionMode: 'danger',
    ...overrides,
  }
}

// =============================================================================
// classifyPrompt Tests
// =============================================================================

describe('classifyPrompt', () => {
  describe('permission prompts', () => {
    const cases: Array<{ input: string; expectedMatch: string }> = [
      { input: 'Do you want to proceed?', expectedMatch: 'Do you want to proceed?' },
      { input: 'Allow bash to run `npm install`', expectedMatch: 'Allow bash to run' },
      { input: '(Y)es  (N)o', expectedMatch: '(Y)es  (N)o' },
      { input: 'Press Enter to allow', expectedMatch: 'Press Enter to allow' },
      { input: 'Allow once  Allow always  Deny', expectedMatch: 'Allow once' },
      { input: 'Do you trust this tool?', expectedMatch: 'Do you trust' },
    ]

    for (const { input, expectedMatch } of cases) {
      it(`detects: "${input}"`, () => {
        const result = classifyPrompt(input)
        expect(result).to.not.be.null
        expect(result!.category).to.equal('permission')
        expect(result!.matchedText).to.equal(expectedMatch)
      })
    }
  })

  describe('continue prompts', () => {
    const cases: Array<{ input: string; expected: string }> = [
      { input: 'Do you want to continue?', expected: 'Do you want to continue?' },
      { input: 'Would you like to continue?', expected: 'Would you like to continue?' },
      { input: 'Shall I continue?', expected: 'Shall I continue?' },
      { input: 'Some output...\nContinue?', expected: 'Continue?' },
      { input: 'Press enter to continue', expected: 'Press enter to continue' },
      { input: 'Would you like me to go ahead?', expected: 'Would you like me to go ahead' },
      { input: 'Should I proceed?', expected: 'Should I proceed?' },
      { input: 'Do you want me to continue with the implementation?', expected: 'Do you want me to continue' },
    ]

    for (const { input, expected } of cases) {
      it(`detects: "${input}"`, () => {
        const result = classifyPrompt(input)
        expect(result).to.not.be.null
        expect(result!.category).to.equal('continue')
        expect(result!.matchedText).to.equal(expected)
      })
    }
  })

  describe('plan approval prompts', () => {
    const cases: Array<{ input: string; expected: string }> = [
      { input: 'Start implementation?', expected: 'Start implementation?' },
      { input: 'Proceed with this plan?', expected: 'Proceed with this plan?' },
      { input: 'Execute this plan?', expected: 'Execute this plan?' },
      { input: 'Approve the plan?', expected: 'Approve the plan?' },
      { input: 'Ready to start?', expected: 'Ready to start?' },
      { input: 'Shall I begin implementing the feature?', expected: 'Shall I begin' },
      { input: 'Do you want to start the refactoring?', expected: 'Do you want to start' },
      { input: 'Go ahead with this plan?', expected: 'Go ahead with this plan?' },
    ]

    for (const { input, expected } of cases) {
      it(`detects: "${input}"`, () => {
        const result = classifyPrompt(input)
        expect(result).to.not.be.null
        expect(result!.category).to.equal('plan_approval')
        expect(result!.matchedText).to.equal(expected)
      })
    }
  })

  describe('model selection prompts', () => {
    const cases: string[] = [
      'Select a model to use:',
      'Choose model for this task',
      'Which model would you like to use?',
      'Pick a model:',
      'Model selection required',
      'Available models:\n1. claude-opus\n2. claude-sonnet',
    ]

    for (const input of cases) {
      it(`detects: "${input.split('\n')[0]}"`, () => {
        const result = classifyPrompt(input)
        expect(result).to.not.be.null
        expect(result!.category).to.equal('model_selection')
      })
    }
  })

  describe('non-matching output', () => {
    const cases: string[] = [
      'Building project... 50% complete',
      'Running tests...',
      'Compiling TypeScript...',
      'Installed 42 packages',
      'All tests passed!',
      '',
    ]

    for (const input of cases) {
      it(`does not match: "${input || '(empty)'}"`, () => {
        const result = classifyPrompt(input)
        expect(result).to.be.null
      })
    }
  })

  describe('priority order', () => {
    it('model_selection takes precedence over other categories', () => {
      // A prompt that could match both model selection and continue
      const input = 'Select a model to continue with'
      const result = classifyPrompt(input)
      expect(result).to.not.be.null
      expect(result!.category).to.equal('model_selection')
    })
  })
})

// =============================================================================
// AutoResponder Tests
// =============================================================================

describe('AutoResponder', () => {
  describe('check()', () => {
    it('auto-sends "y" for permission prompts in danger mode', () => {
      let sentMessage = ''
      let sentTo = ''
      const responder = new AutoResponder({
        deps: fakeDeps({
          captureTmuxPane: () => 'Do you want to proceed? (Y)es (N)o',
          sendTmuxMessage: (sid, msg) => { sentTo = sid; sentMessage = msg },
        }),
      })

      const action = responder.check(makeSession())

      expect(action).to.not.be.null
      expect(action!.category).to.equal('permission')
      expect(action!.response).to.equal('y')
      expect(sentMessage).to.equal('y')
      expect(sentTo).to.equal('prlt-session-test1')
    })

    it('does not respond to permission prompts in safe mode', () => {
      const responder = new AutoResponder({
        deps: fakeDeps({
          captureTmuxPane: () => 'Do you want to proceed? (Y)es (N)o',
        }),
      })

      const action = responder.check(makeSession({ permissionMode: 'safe' }))
      expect(action).to.be.null
    })

    it('auto-sends "yes" for continue prompts in any mode', () => {
      let sentMessage = ''
      const responder = new AutoResponder({
        deps: fakeDeps({
          captureTmuxPane: () => 'Would you like to continue?',
          sendTmuxMessage: (_sid, msg) => { sentMessage = msg },
        }),
      })

      // Works in safe mode too
      const action = responder.check(makeSession({ permissionMode: 'safe' }))

      expect(action).to.not.be.null
      expect(action!.category).to.equal('continue')
      expect(action!.response).to.equal('yes')
      expect(sentMessage).to.equal('yes')
    })

    it('auto-sends "yes" for plan approval in danger mode', () => {
      let sentMessage = ''
      const responder = new AutoResponder({
        deps: fakeDeps({
          captureTmuxPane: () => 'Proceed with this plan?',
          sendTmuxMessage: (_sid, msg) => { sentMessage = msg },
        }),
      })

      const action = responder.check(makeSession({ permissionMode: 'danger' }))

      expect(action).to.not.be.null
      expect(action!.category).to.equal('plan_approval')
      expect(action!.response).to.equal('yes')
      expect(sentMessage).to.equal('yes')
    })

    it('does not respond to plan approval in safe mode', () => {
      const responder = new AutoResponder({
        deps: fakeDeps({
          captureTmuxPane: () => 'Proceed with this plan?',
        }),
      })

      const action = responder.check(makeSession({ permissionMode: 'safe' }))
      expect(action).to.be.null
    })

    it('NEVER responds to model selection prompts', () => {
      let messageSent = false
      const responder = new AutoResponder({
        deps: fakeDeps({
          captureTmuxPane: () => 'Select a model to use:\n1. claude-opus\n2. claude-sonnet',
          sendTmuxMessage: () => { messageSent = true },
        }),
      })

      const action = responder.check(makeSession({ permissionMode: 'danger' }))

      expect(action).to.be.null
      expect(messageSent).to.be.false
    })

    it('returns null when pane capture fails', () => {
      const responder = new AutoResponder({
        deps: fakeDeps({ captureTmuxPane: () => null }),
      })

      const action = responder.check(makeSession())
      expect(action).to.be.null
    })

    it('returns null when no prompt detected', () => {
      const responder = new AutoResponder({
        deps: fakeDeps({
          captureTmuxPane: () => 'Building project... 75% complete',
        }),
      })

      const action = responder.check(makeSession())
      expect(action).to.be.null
    })

    it('returns null when sendTmuxMessage throws', () => {
      const responder = new AutoResponder({
        deps: fakeDeps({
          captureTmuxPane: () => 'Do you want to continue?',
          sendTmuxMessage: () => { throw new Error('tmux not available') },
        }),
      })

      const action = responder.check(makeSession())
      expect(action).to.be.null
    })
  })

  describe('cooldown enforcement', () => {
    it('enforces minimum cooldown between auto-responses', () => {
      let sendCount = 0
      const responder = new AutoResponder({
        deps: fakeDeps({
          captureTmuxPane: () => 'Do you want to continue?',
          sendTmuxMessage: () => { sendCount++ },
        }),
        cooldownMs: AUTO_RESPOND_COOLDOWN_MS, // 10 seconds
      })

      const session = makeSession()

      // First call: should respond
      const action1 = responder.check(session)
      expect(action1).to.not.be.null
      expect(sendCount).to.equal(1)

      // Second call immediately: should be blocked by cooldown
      const action2 = responder.check(session)
      expect(action2).to.be.null
      expect(sendCount).to.equal(1)
    })

    it('allows response after cooldown expires', () => {
      let sendCount = 0
      const responder = new AutoResponder({
        deps: fakeDeps({
          captureTmuxPane: () => 'Do you want to continue?',
          sendTmuxMessage: () => { sendCount++ },
        }),
        cooldownMs: 0, // No cooldown for testing
      })

      const session = makeSession()

      responder.check(session)
      expect(sendCount).to.equal(1)

      responder.check(session)
      expect(sendCount).to.equal(2)
    })

    it('tracks cooldown per session independently', () => {
      let sendCount = 0
      const responder = new AutoResponder({
        deps: fakeDeps({
          captureTmuxPane: () => 'Do you want to continue?',
          sendTmuxMessage: () => { sendCount++ },
        }),
        cooldownMs: AUTO_RESPOND_COOLDOWN_MS,
      })

      const session1 = makeSession({ sessionId: 'session-1' })
      const session2 = makeSession({ sessionId: 'session-2' })

      // Both should respond on first call
      responder.check(session1)
      responder.check(session2)
      expect(sendCount).to.equal(2)

      // Both should be blocked on second call
      responder.check(session1)
      responder.check(session2)
      expect(sendCount).to.equal(2)
    })
  })

  describe('logging', () => {
    it('writes actions to log file when configured', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-responder-test-'))
      const logPath = path.join(tmpDir, 'auto-respond.log')

      try {
        const responder = new AutoResponder({
          deps: fakeDeps({
            captureTmuxPane: () => 'Do you want to continue?',
            sendTmuxMessage: () => {},
          }),
          logFilePath: logPath,
        })

        const action = responder.check(makeSession())
        expect(action).to.not.be.null

        const logContent = fs.readFileSync(logPath, 'utf-8').trim()
        const entry = JSON.parse(logContent)

        expect(entry.action).to.equal('auto_respond')
        expect(entry.category).to.equal('continue')
        expect(entry.response).to.equal('yes')
        expect(entry.agentName).to.equal('test-agent')
        expect(entry.ticketId).to.equal('TKT-027')
        expect(entry.matchedText).to.be.a('string')
        expect(entry.timestamp).to.be.a('string')
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('action includes timestamp and matched prompt text', () => {
      const responder = new AutoResponder({
        deps: fakeDeps({
          captureTmuxPane: () => 'Allow bash to run `rm -rf /tmp/test`',
          sendTmuxMessage: () => {},
        }),
      })

      const action = responder.check(makeSession())

      expect(action).to.not.be.null
      expect(action!.timestamp).to.be.instanceOf(Date)
      expect(action!.matchedText).to.include('Allow bash to run')
      expect(action!.category).to.equal('permission')
      expect(action!.response).to.equal('y')
    })
  })

  describe('session cleanup', () => {
    it('removes cooldown tracking for inactive sessions', () => {
      let sendCount = 0
      const responder = new AutoResponder({
        deps: fakeDeps({
          captureTmuxPane: () => 'Do you want to continue?',
          sendTmuxMessage: () => { sendCount++ },
        }),
        cooldownMs: AUTO_RESPOND_COOLDOWN_MS,
      })

      const session = makeSession({ sessionId: 'session-cleanup-test' })
      responder.check(session)
      expect(sendCount).to.equal(1)

      // Session is still in cooldown
      responder.check(session)
      expect(sendCount).to.equal(1)

      // Clean up — session removed from active set
      responder.cleanupSessions(new Set())

      // After cleanup, cooldown is gone — should respond again
      responder.check(session)
      expect(sendCount).to.equal(2)
    })
  })

  describe('reset', () => {
    it('clears all internal state', () => {
      let sendCount = 0
      const responder = new AutoResponder({
        deps: fakeDeps({
          captureTmuxPane: () => 'Do you want to continue?',
          sendTmuxMessage: () => { sendCount++ },
        }),
        cooldownMs: AUTO_RESPOND_COOLDOWN_MS,
      })

      responder.check(makeSession())
      expect(sendCount).to.equal(1)

      responder.reset()

      // After reset, cooldown cleared — should respond again
      responder.check(makeSession())
      expect(sendCount).to.equal(2)
    })
  })
})
